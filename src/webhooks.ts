import {Application} from "express";
import * as express from "express";
import * as crypto from "crypto";
import * as https from "https";
import concat = require("concat-stream");
import {createErrorFromResponse, SubscriptionDeniedError} from "./errors";
import {EventEmitter} from "events";
import {WebhookRenewalScheduler} from "./scheduling";
import {WebhookPayload} from "./payload_types";


type TwitchWebhookManagerConfig = {
    hostname: string, // Hostname. Used in computation of the callback URL that subscribes to events
    app: Application, // Express application to add REST endpoints to.
    client_id: string, // Client id associated with the OAuth token
    base_path?: string, // Base path for the webhook "namespace". The full path is computed as ${hostname}/${base_path}/${endpoint_name}. If not specified, the base_path is omitted
    secret?: string, // default secret to use for hub.secret. If none is provided, a cryptographically secure random string is constructed to be used.
    renewalScheduler?: WebhookRenewalScheduler; // Rescheduler; If none is provided, then webhooks will not be renewed.
}

type ErrorCallback = (e: SubscriptionDeniedError) => void;
type EventReceivedCallback = (msg: WebhookPayload) => void;
type GetOAuthTokenCallback = () => Promise<string>;
type RefreshOAuthTokenCallback = () => Promise<string>;

type WebhookOptions = {
    errorCallback: ErrorCallback;
    onReceivedCallback: EventReceivedCallback;
    getOAuthToken: GetOAuthTokenCallback; // Returns the OAuth token (wrapped in a promise; this is asyncronous)
    refreshOAuthToken: RefreshOAuthTokenCallback; // Refreshes the OAuth token; Returns the updated OAuth token (wrapped in a promise; this is asyncronous)
    secret?: string; // Secret for this webhook. Defaults to the TwitchWebhookManagerConfig's secret.
    lease_seconds?: number; // Seconds to subscribe for this webhook, between 0 and 864000 (inc). Defaults to 864000
}

type HubParams = {
    'hub.callback': string;
    'hub.mode': string;
    'hub.topic': string;
    'hub.lease_seconds': number;
    'hub.secret': string;
};

enum WebhookType {
    UserFollows,
    StreamChanged,
    UserChanged,
    ExtensionTransactionCreated,
    ModeratorChange,
    ChannelBanChange,
    Subscription
}

const WebhookTypeEndpoint: Map<WebhookType, string> = new Map<WebhookType, string>();
WebhookTypeEndpoint.set(WebhookType.UserFollows, "follows");
WebhookTypeEndpoint.set(WebhookType.StreamChanged, "stream_changed");
WebhookTypeEndpoint.set(WebhookType.UserChanged, "user_changed");
WebhookTypeEndpoint.set(WebhookType.ExtensionTransactionCreated, "extension_transaction_created");
WebhookTypeEndpoint.set(WebhookType.ModeratorChange, "moderator_change");
WebhookTypeEndpoint.set(WebhookType.ChannelBanChange, "channel_ban_change");
WebhookTypeEndpoint.set(WebhookType.Subscription, "subscription");


const WebhookTypeTopic: Map<WebhookType, string> = new Map<WebhookType, string>();
WebhookTypeTopic.set(WebhookType.UserFollows, "https://api.twitch.tv/helix/users/follows");
WebhookTypeTopic.set(WebhookType.StreamChanged, "https://api.twitch.tv/helix/streams");
WebhookTypeTopic.set(WebhookType.UserChanged, "https://api.twitch.tv/helix/users");
WebhookTypeTopic.set(WebhookType.ExtensionTransactionCreated, "https://api.twitch.tv/helix/extensions/transactions");
WebhookTypeTopic.set(WebhookType.ModeratorChange, "https://api.twitch.tv/helix/moderation/moderators/events");
WebhookTypeTopic.set(WebhookType.ChannelBanChange, "https://api.twitch.tv/helix/moderation/banned/events");
WebhookTypeTopic.set(WebhookType.Subscription, "https://api.twitch.tv/helix/subscriptions/events");

const TWITCH_HUB_URL = "https://api.twitch.tv/helix/webhooks/hub";

//Represents a single subscription.
class Webhook extends EventEmitter {
    public manager: TwitchWebhookManager;
    public type: WebhookType;
    public computedTopicQueryParams: string = "";
    public computedTopicUrl: string = "";
    public subscribed: boolean = false;
    public subscriptionEnd: number; // Unix timestamp for when this subscription will end
    readonly config: WebhookOptions;
    private paramsChanged: boolean = false;
    private callbackUrlQueryParameters: Map<string, string> = new Map<string, string>();

    constructor(config: WebhookOptions, manager: TwitchWebhookManager) {
        super({captureRejections: true});
        this.manager = manager;
        config.lease_seconds = config.lease_seconds || 864000;
        config.secret = config.secret || manager.config.secret;
        this.config = config;
    }

    public computeTopicUrl(): void {
        if (this.paramsChanged) {
            let isFirst = true;
            let topicParams = '';

            //Note: These endpoints have the restriction that the query parameters must be sorted.
            //Because of this, we sort them here. This is also useful for us, since it means that each
            //set of query parameters will always be one string, regardless of how the parameters are added.
            let sortedParams = Array.from(this.callbackUrlQueryParameters.keys()).sort();
            for (let param_name of sortedParams) {
                let val = this.callbackUrlQueryParameters.get(param_name);
                topicParams += (isFirst ? '?' : '&') + `${param_name}=${encodeURIComponent(val)}`;
                isFirst = false;
            }

            this.computedTopicQueryParams = topicParams;
            this.computedTopicUrl = WebhookTypeTopic.get(this.type) + topicParams;
            this.paramsChanged = false;
        }
    }

    public setParam(param: string, val: string): void {
        this.callbackUrlQueryParameters.set(param, val);
        this.paramsChanged = true;
    }

    public deleteParam(param: string): boolean {
        return this.callbackUrlQueryParameters.delete(param);
    }
}

class TwitchWebhookManager {
    readonly config: TwitchWebhookManagerConfig;
    readonly webhooks: Map<string, Webhook> = new Map<string, Webhook>(); // Map of end URL (including query parameters) to webhook
    renewalInterval: NodeJS.Timeout;

    constructor(config: TwitchWebhookManagerConfig) {
        config.secret = config.secret || crypto.randomBytes(90).toString("hex"); // Note; the max length of this secret is 200; The default is 180 characters.
        this.config = config;
        this.addWebhookEndpoints();
        if (config.renewalScheduler && config.renewalScheduler.getMetaData().runInterval !== Infinity) {
            this.renewalInterval = setInterval(() => config.renewalScheduler.run(), config.renewalScheduler.getMetaData().runInterval)
        }
    }

    // Unsubs from all webhooks; Ends the renewal scheduler
    public async destroy() {
        if (this.renewalInterval) {
            clearInterval(this.renewalInterval);
        }

        if (this.config.renewalScheduler) {
            this.config.renewalScheduler.destroy();
        }

        let promises = [];
        for (let webhook of Array.from(this.webhooks.values())) {
            promises.push(this.unsubscribe(webhook));
        }
        await Promise.all(promises);
    }

    public async addUserFollowsSubscription(config: WebhookOptions, to_id?: string, from_id?: string): Promise<Webhook> {
        if (!to_id && !from_id) {
            throw new Error("to_id or from_id (or both) must be specified!");
        }

        let webhook = new Webhook(config, this);
        webhook.setParam("first", "1");

        if (to_id) {
            webhook.setParam("to_id", to_id);
        }

        if (from_id) {
            webhook.setParam("from_id", from_id);
        }

        webhook.type = WebhookType.UserFollows;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addStreamChangedSubscription(config: WebhookOptions, user_id: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("user_id", user_id);
        webhook.type = WebhookType.StreamChanged;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addUserChangedSubscription(config: WebhookOptions, user_id: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("id", user_id);
        webhook.type = WebhookType.UserChanged;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addExtensionTransactionCreatedSubscription(config: WebhookOptions, extension_id: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("extension_id", extension_id);
        webhook.setParam("first", "1");
        webhook.type = WebhookType.ExtensionTransactionCreated;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addModeratorChangedEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("first", "1");
        webhook.setParam("broadcaster_id", broadcaster_id);

        if (user_id) {
            webhook.setParam("user_id", user_id);
        }

        webhook.type = WebhookType.ModeratorChange;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addChannelBanChangedEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("first", "1");
        webhook.setParam("broadcaster_id", broadcaster_id);

        if (user_id) {
            webhook.setParam("user_id", user_id);
        }

        webhook.type = WebhookType.ModeratorChange;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async addSubscriptionEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string,
                                      gifter_id?: string, gifter_name?: string): Promise<Webhook> {
        let webhook = new Webhook(config, this);
        webhook.setParam("broadcaster_id", broadcaster_id);
        webhook.setParam("first", "1");
        if (user_id) {
            webhook.setParam("user_id", user_id);
        }

        if (gifter_id) {
            webhook.setParam("gifter_id", gifter_id);
        }

        if (gifter_name) {
            webhook.setParam("gifter_name", gifter_name);
        }

        webhook.type = WebhookType.Subscription;

        await this.changeSub(webhook, true);
        return webhook;
    }

    public async unsubscribe(webhook: Webhook): Promise<void> {
        await this.changeSub(webhook, false);

        let callbackUrl = getCallbackUrl(webhook);
        this.webhooks.delete(callbackUrl);

        //Don't renew anymore
        if (this.config.renewalScheduler) {
            this.config.renewalScheduler.removeFromScheduler(webhook);
        }
    }

    public async resubscribe(webhook: Webhook): Promise<void> {
        //We do not need to check if the webhook is subscribed;
        //If the webhook is subscribed already, it will simply be renewed.
        await this.changeSub(webhook, true);
    }

    private async changeSub(webhook: Webhook, subscribe: boolean): Promise<void> {
        webhook.computeTopicUrl();
        let callbackUrl = getCallbackUrl(webhook);
        let hubParams: HubParams = {
            "hub.callback": callbackUrl,
            "hub.mode": subscribe ? 'subscribe' : 'unsubscribe',
            "hub.topic": webhook.computedTopicUrl,
            "hub.lease_seconds": webhook.config.lease_seconds,
            "hub.secret": webhook.config.secret
        };
        let token = await webhook.config.getOAuthToken();
        return new Promise((resolve, reject) => {
            doHubRequest(webhook, hubParams, token, true, resolve, reject);
        });
    }

    //Hooks configured endpoints into the express app.
    private addWebhookEndpoints() {
        let app = this.config.app;

        // Middleware that will catch requests and validate that they match up with the hub secret
        let verification_middleware = getVerificationMiddleware(this);

        for (let type in Object.keys(WebhookType).filter(x => !isNaN(Number(x)))) {
            let endpoint_path = getEndpointPath(this.config.base_path, Number(type));
            //Configure middleware
            app.use(endpoint_path, verification_middleware);
            app.use(endpoint_path, express.urlencoded());

            app.post(endpoint_path, (req, res) => {
                let callback_url_str = `${this.config.hostname}${req.originalUrl}`;
                let webhook = this.webhooks.get(callback_url_str);
                if (webhook) {
                    let msg = req.body;
                    res.status(200);
                    res.end();
                    //Schedule the callback to run ASAP.
                    setImmediate(() => webhook.config.onReceivedCallback(msg));
                } else {
                    res.status(404);
                    console.error(`Got POST for unknown webhook URL: ${req.originalUrl}`);
                }
            });

            app.get(endpoint_path, (req, res) => {
                let originalUrl = new URL(req.originalUrl, this.config.hostname);
                let topicURL = new URL(decodeURIComponent(originalUrl.searchParams.get("hub.topic")));
                let callback_url_str = `${this.config.hostname}${endpoint_path}${topicURL.search}`;
                let webhook = this.webhooks.get(callback_url_str);

                if (webhook) {
                    if (!originalUrl.searchParams.get("hub.mode") || originalUrl.searchParams.get("hub.mode") === "denied") {
                        res.end();
                        setImmediate(() =>
                            webhook.config.errorCallback(new SubscriptionDeniedError(originalUrl.searchParams.get("hub.topic"),
                                callback_url_str, originalUrl.searchParams.get("hub.reason"))));
                        return;
                    }

                    if (originalUrl.searchParams.get("hub.lease_seconds")) {
                        webhook.subscriptionEnd = Date.now() + parseInt(originalUrl.searchParams.get("hub.lease_seconds"));
                    } else {
                        webhook.subscriptionEnd = Date.now() + webhook.config.lease_seconds; // Assume lease seconds we sent is respected.
                    }

                    webhook.subscribed = true;
                    res.setHeader("Content-Type", "text/plain");
                    res.status(200);
                    res.end(originalUrl.searchParams.get("hub.challenge"));

                    webhook.emit("subscribed");

                    if (this.config.renewalScheduler) {
                        this.config.renewalScheduler.addToScheduler(webhook);
                    }
                } else {
                    console.error(`Got GET for unknown webhook URL: ${callback_url_str}`);
                    res.status(404);
                    res.end();
                }
            });
        }
    }
}

//Do a request to the Twitch WebSub hub.
function doHubRequest(webhook: Webhook, hubParams: HubParams, oAuthToken: string, refreshOnFail: boolean, resolve: () => void, reject: (e: Error) => void) {
    let paramJson = Buffer.from(JSON.stringify(hubParams), 'utf8');
    let callbackUrl = getCallbackUrl(webhook);
    let req = https.request(TWITCH_HUB_URL, {
        headers: {
            "Authorization": `Bearer ${oAuthToken}`,
            "Client-ID": webhook.manager.config.client_id,
            "Content-Type": 'application/json',
            "Content-Length": paramJson.length
        },
        method: 'POST',
        timeout: 10000
    }, (res) => {
        let body = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            body += chunk;
        });

        res.on('end', async () => {
            if (Math.floor(res.statusCode / 100) === 2) {
                if (hubParams["hub.mode"] === 'subscribe') {
                    webhook.subscribed = false;
                    webhook.manager.webhooks.delete(callbackUrl);
                } else {
                    webhook.manager.webhooks.set(callbackUrl, webhook);
                }
                resolve();
            } else {
                if (refreshOnFail) {
                    let newToken: string = await webhook.config.refreshOAuthToken();
                    //Try once more with the new token, don't refresh this time.
                    doHubRequest(webhook, hubParams, newToken, false, resolve, reject);
                } else {
                    reject(createErrorFromResponse(res, body));
                }
            }
        });
    });

    req.on('error', (e) => {
        reject(e);
    });

    req.write(paramJson);
    req.end();
}

function getEndpointPath(basePath: string, webhookType: WebhookType): string {
    let normalizedBasePath: string;

    if (basePath) {
        normalizedBasePath = "/" + basePath;
    } else {
        normalizedBasePath = "";
    }
    return `${normalizedBasePath}/${WebhookTypeEndpoint.get(Number(webhookType))}`;
}

function getCallbackUrl(webhook: Webhook): string {
    webhook.computeTopicUrl();
    return webhook.manager.config.hostname +
        getEndpointPath(webhook.manager.config.base_path, webhook.type) + webhook.computedTopicQueryParams;
}

function getVerificationMiddleware(twitchWebhookManager: TwitchWebhookManager) {
    return function verificationMiddleware(req, res, next) {
        // We take care of the JSON body parsing here; This is a side effect of how middleware and streams work,
        // so we can't just use the json body parsing middleware...
        if (req.header("content-type") && req.header("content-type").includes('application/json')) {
            req.pipe(concat((data) => {
                req.body = JSON.parse(data.toString("utf8"));
            }));
        }

        if (req.method == 'POST') {
            // Only POST requests matter for secret validation;
            // GET requests are simply to validate the publishing was correct,
            // and are not signed since it is not a notification payload.
            if (req.header("X-Hub-Signature")) {
                let callback_url = new URL(req.originalUrl, twitchWebhookManager.config.hostname);
                let webhook = twitchWebhookManager.webhooks.get(callback_url.href);
                let secret: string;
                if (webhook) {
                    secret = webhook.config.secret;
                } else {
                    secret = twitchWebhookManager.config.secret;
                }

                //TODO: Possibly support some other algorithms? (sha1, sha384, sha512 are recognized in the spec)
                req.pipe(crypto.createHmac("sha256", secret))
                    .pipe(concat((data) => {
                        if (data.toString("hex") === req.header("X-Hub-Signature").split('=')[1]) {
                            next();
                        } else {
                            console.error("Request gave bad X-Hub-Signature; Rejecting request.");
                            res.sendStatus(400);
                            res.end();
                        }
                    }));
            } else {
                console.error("Request had no X-Hub-Signature header; Rejecting request.");
                res.sendStatus(400);
                res.end();
            }
        } else {
            next();
        }
    };
}

export {
    TwitchWebhookManager,
    Webhook,
    WebhookOptions
}