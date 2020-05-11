import {Application} from "express";
import * as express from "express";
import * as crypto from "crypto";
import * as https from "https";
import concat = require("concat-stream");
import {createErrorFromResponse, SubscriptionDeniedError} from "./errors";
import {EventEmitter} from "events";
import {WebhookRenewalScheduler} from "./scheduling";
import {
    createWebhookPersistenceObject,
    getIdFromTypeAndParams, MemoryBasedTwitchWebhookPersistenceManager,
    TwitchWebhookPersistenceManager,
    WebhookPersistenceObject
} from "./persistence";


type TwitchWebhookManagerConfig = {
    hostname: string, // Hostname. Used in computation of the callback URL that subscribes to events
    app: Application, // Express application to add REST endpoints to.
    client_id: string, // Client id associated with the OAuth token
    getOAuthToken: GetOAuthTokenCallback, // Returns the OAuth token (wrapped in a promise; this is asynchronous). If userId is undefined, then it may be an application token or any user token.
    refreshOAuthToken: RefreshOAuthTokenCallback, // Refreshes the OAuth token; Returns the updated OAuth token (wrapped in a promise; this is asynchronous). Takes failed oauth token as a parameter
    base_path?: string, // Base path for the webhook "namespace". The full path is computed as ${hostname}/${base_path}/${endpoint_name}. If not specified, the base_path is omitted
    secret?: string, // default secret to use for hub.secret. If none is provided, a cryptographically secure random string is constructed to be used.
    renewalScheduler?: WebhookRenewalScheduler; // Rescheduler; If none is provided, then webhooks will not be renewed.
    persistenceManager?: TwitchWebhookPersistenceManager; // Persistence manager; If none is provided, an IN-MEMORY persistence manager will be used.
}

type GetOAuthTokenCallback = (userId?: string) => Promise<string>;
type RefreshOAuthTokenCallback = (token: string) => Promise<string>;

type WebhookId = string;

type WebhookOptions = {
    secret?: string; // Secret for this webhook. Defaults to the TwitchWebhookManagerConfig's secret.
    leaseSeconds?: number; // Seconds to subscribe for this webhook, between 0 and 864000 (inc). Defaults to 864000
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

class TwitchWebhookManager extends EventEmitter {
    readonly config: TwitchWebhookManagerConfig;
    renewalInterval: NodeJS.Timeout;

    constructor(config: TwitchWebhookManagerConfig) {
        super({captureRejections: true});
        config.secret = config.secret || crypto.randomBytes(90).toString("hex"); // Note; the max length of this secret is 200; The default is 180 characters.
        config.persistenceManager = config.persistenceManager || new MemoryBasedTwitchWebhookPersistenceManager();
        this.config = config;
        this.addWebhookEndpoints();
        if (config.renewalScheduler && config.renewalScheduler.getMetaData().runInterval !== Infinity) {
            this.renewalInterval = setInterval(() => config.renewalScheduler.run(), config.renewalScheduler.getMetaData().runInterval)
        }
    }

    async init() : Promise<void> {
        if(this.config.renewalScheduler){
            let webhooks = await this.config.persistenceManager.getAllWebhooks();
            for(let webhook of webhooks) {
                this.config.renewalScheduler.addToScheduler(webhook);
            }
        }
    }

    // Unsubs from all webhooks; Ends the renewal scheduler
    public async destroy() {
        if (this.renewalInterval) {
            clearInterval(this.renewalInterval);
            this.renewalInterval = undefined;
        }

        if (this.config.renewalScheduler) {
            await this.config.renewalScheduler.destroy();
            this.config.renewalScheduler = undefined;
        }

        if (this.config.persistenceManager) {
            await this.config.persistenceManager.destroy();
        }
    }

    public async unsubFromAll() {
        let promises = [];
        let webhooks = await this.config.persistenceManager.getAllWebhooks();
        for (let webhook of webhooks) {
            promises.push(this.unsubscribePersistenceObject(webhook));
        }
        await Promise.all(promises);
    }

    public async addUserFollowsSubscription(config: WebhookOptions, to_id?: string, from_id?: string): Promise<WebhookId> {
        if (!to_id && !from_id) {
            throw new Error("to_id or from_id (or both) must be specified!");
        }

        let params = new Map<string, string>();

        params.set("first", "1");

        if (to_id) {
            params.set("to_id", to_id);
        }

        if (from_id) {
            params.set("from_id", from_id);
        }

        let webhook = createWebhookPersistenceObject(this, WebhookType.UserFollows, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true);
        return webhook.id;
    }

    public async addStreamChangedSubscription(config: WebhookOptions, user_id: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("user_id", user_id);

        let webhook = createWebhookPersistenceObject(this, WebhookType.StreamChanged, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true);
        return webhook.id;
    }

    public async addUserChangedSubscription(config: WebhookOptions, user_id: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("id", user_id);

        let webhook = createWebhookPersistenceObject(this, WebhookType.UserChanged, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true, user_id);
        return webhook.id;
    }

    public async addExtensionTransactionCreatedSubscription(config: WebhookOptions, extension_id: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("extension_id", extension_id);
        params.set("first", "1");

        let webhook = createWebhookPersistenceObject(this, WebhookType.ExtensionTransactionCreated, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true);
        return webhook.id;
    }

    public async addModeratorChangedEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("first", "1");
        params.set("broadcaster_id", broadcaster_id);

        if (user_id) {
            params.set("user_id", user_id);
        }

        let webhook = createWebhookPersistenceObject(this, WebhookType.ModeratorChange, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true, broadcaster_id);
        return webhook.id;
    }

    public async addChannelBanChangedEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("first", "1");
        params.set("broadcaster_id", broadcaster_id);

        if (user_id) {
            params.set("user_id", user_id);
        }

        let webhook = createWebhookPersistenceObject(this, WebhookType.ChannelBanChange, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true, broadcaster_id);
        return webhook.id;
    }

    public async addSubscriptionEvent(config: WebhookOptions, broadcaster_id: string, user_id?: string,
                                      gifter_id?: string, gifter_name?: string): Promise<WebhookId> {
        let params = new Map<string, string>();
        params.set("broadcaster_id", broadcaster_id);
        params.set("first", "1");
        if (user_id) {
            params.set("user_id", user_id);
        }

        if (gifter_id) {
            params.set("gifter_id", gifter_id);
        }

        if (gifter_name) {
            params.set("gifter_name", gifter_name);
        }

        let webhook = createWebhookPersistenceObject(this, WebhookType.Subscription, params, config);

        let oldWebhook = await this.config.persistenceManager.getWebhookById(webhook.id);
        if (oldWebhook) {
            return oldWebhook.id;
        }

        await this.config.persistenceManager.persistWebhook(webhook);
        await this.changeSub(webhook, true, broadcaster_id);
        return webhook.id;
    }

    public async unsubscribe(webhookId: WebhookId): Promise<void> {
        let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
        this.unsubscribePersistenceObject(webhook);
    }

    public async unsubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void> {
        await this.changeSub(webhook, false);

        await this.config.persistenceManager.deleteWebhook(webhook.id);

        //Don't renew anymore
        if (this.config.renewalScheduler) {
            this.config.renewalScheduler.removeFromScheduler(webhook.id);
        }
    }

    public async resubscribe(webhookId: WebhookId): Promise<void> {
        //We do not need to check if the webhook is subscribed;
        //If the webhook is subscribed already, it will simply be renewed.
        let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
        await this.changeSub(webhook, true);
    }

    public async resubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void> {
        //We do not need to check if the webhook is subscribed;
        //If the webhook is subscribed already, it will simply be renewed.
        await this.changeSub(webhook, true);
    }

    private async changeSub(webhook: WebhookPersistenceObject, subscribe: boolean, userId?: string): Promise<void> {
        let callbackUrl = getCallbackUrl(this, webhook);
        let hubParams: HubParams = {
            "hub.callback": callbackUrl,
            "hub.mode": subscribe ? 'subscribe' : 'unsubscribe',
            "hub.topic": webhook.href,
            "hub.lease_seconds": webhook.leaseSeconds,
            "hub.secret": webhook.secret
        };

        let token = await this.config.getOAuthToken(userId);
        return new Promise((resolve, reject) => {
            doHubRequest(webhook, this, hubParams, token, true, resolve, reject);
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
            app.use(endpoint_path, express.urlencoded({
                extended: false
            }));

            app.post(endpoint_path, async (req, res) => {
                let webhookId = getIdFromTypeAndParams(Number(type), new URL(req.url, `https://${req.headers.host}`).search);
                let webhook = await this.config.persistenceManager.getWebhookById(webhookId);
                if (webhook) {
                    let msg = req.body;
                    res.status(200);
                    res.end();

                    this.emit('message', type, webhookId, msg);
                } else {
                    res.status(404);
                    console.error(`Got POST for unknown webhook URL: ${req.originalUrl}`);
                }
            });

            app.get(endpoint_path, async (req, res) => {
                let originalUrl = new URL(req.originalUrl, this.config.hostname);
                let topicURL = new URL(decodeURIComponent(originalUrl.searchParams.get("hub.topic")));
                let webhookId = getIdFromTypeAndParams(Number(type), topicURL.search);
                let webhook = await this.config.persistenceManager.getWebhookById(webhookId);

                if (webhook) {
                    if (!originalUrl.searchParams.get("hub.mode") || originalUrl.searchParams.get("hub.mode") === "denied") {
                        res.end();
                        await this.config.persistenceManager.deleteWebhook(webhookId);
                        this.emit('error', new SubscriptionDeniedError(webhook, originalUrl.searchParams.get("hub.reason")));
                        return;
                    }

                    webhook.subscriptionStart = new Date();

                    if (originalUrl.searchParams.get("hub.lease_seconds")) {
                        webhook.subscriptionEnd = new Date(webhook.subscriptionStart.getTime() + parseInt(originalUrl.searchParams.get("hub.lease_seconds")) * 1000);
                    } else {
                        webhook.subscriptionEnd = new Date(Date.now() + webhook.leaseSeconds * 1000); // Assume lease seconds we sent is respected.
                    }

                    webhook.subscribed = true;
                    res.setHeader("Content-Type", "text/plain");
                    res.status(200);
                    res.end(originalUrl.searchParams.get("hub.challenge"));

                    await this.config.persistenceManager.saveWebhook(webhook);
                    this.emit("subscribed", webhookId);

                    if (this.config.renewalScheduler) {
                        this.config.renewalScheduler.addToScheduler(webhook);
                    }
                } else {
                    console.error(`Got GET for unknown webhook URL: ${topicURL.href}`);
                    res.status(404);
                    res.end();
                }
            });
        }
    }
}

//Do a request to the Twitch WebSub hub.
function doHubRequest(webhook: WebhookPersistenceObject, manager: TwitchWebhookManager, hubParams: HubParams, oAuthToken: string, refreshOnFail: boolean, resolve: () => void, reject: (e: Error) => void) {
    let paramJson = Buffer.from(JSON.stringify(hubParams), 'utf8');
    let req = https.request(TWITCH_HUB_URL, {
        headers: {
            "Authorization": `Bearer ${oAuthToken}`,
            "Client-ID": manager.config.client_id,
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
                resolve();
            } else {
                if (refreshOnFail) {
                    let newToken: string = await manager.config.refreshOAuthToken(oAuthToken);
                    //Try once more with the new token, don't refresh this time.
                    doHubRequest(webhook, manager, hubParams, newToken, false, resolve, reject);
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

function getCallbackUrl(manager: TwitchWebhookManager, webhook: WebhookPersistenceObject): string {
    return manager.config.hostname +
        getEndpointPath(manager.config.base_path, webhook.type) + new URL(webhook.href).search;
}

function getVerificationMiddleware(twitchWebhookManager: TwitchWebhookManager) {
    return async function verificationMiddleware(req, res, next) {
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
                let callback_url = new URL(req.url, `https://${req.headers.host}`);
                let splitPath = callback_url.pathname.split('/');
                let lastPath = splitPath[splitPath.length - 1];
                let webhook = await twitchWebhookManager.config.persistenceManager.getWebhookById(lastPath + callback_url.search);

                let secret: string;
                if (webhook) {
                    secret = webhook.secret;
                } else {
                    secret = twitchWebhookManager.config.secret;
                }

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
    WebhookTypeEndpoint,
    WebhookTypeTopic,
    WebhookOptions,
    WebhookType,
    WebhookId,
    GetOAuthTokenCallback,
    RefreshOAuthTokenCallback
}