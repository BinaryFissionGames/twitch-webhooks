import {Application} from "express";
import {WebhookRenewalScheduler} from "./scheduling";
import {TwitchWebhookPersistenceManager} from "./persistence";

type Logger = {
    debug: (message?:any, ...args: any[]) => void, //Debug messages (very verbose)
    info: (message?:any, ...args: any[]) => void, //info messages (General usage messages, pretty verbose)
    error: (message?:any, ...args: any[]) => void //Error messages (something goes wrong)
}

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
    hubUrl?: string; // Configurable hub URL - useful for testing with a mocked hub. Defaults to twitch's actual hub URL
    logger?: Logger // Logging interface; if undefined, a 'no-op' logger will be used. Compatible with the default 'console' object.
}

type TwitchWebhookManagerConfig_Internal = {
    hostname: string,
    app: Application,
    client_id: string,
    getOAuthToken: GetOAuthTokenCallback,
    refreshOAuthToken: RefreshOAuthTokenCallback,
    base_path?: string,
    secret: string,
    renewalScheduler?: WebhookRenewalScheduler;
    persistenceManager: TwitchWebhookPersistenceManager;
    hubUrl: string,
    logger: Logger
}

type GetOAuthTokenCallback = (userId?: string) => Promise<string>;
type RefreshOAuthTokenCallback = (token: string) => Promise<string>;

type WebhookOptions = {
    secret?: string; // Secret for this webhook. Defaults to the TwitchWebhookManagerConfig's secret.
    leaseSeconds?: number; // Seconds to subscribe for this webhook, between 0 and 864000 (inc). Defaults to 864000
}

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

export {
    WebhookType,
    WebhookTypeTopic,
    WebhookTypeEndpoint,
    WebhookOptions,
    TwitchWebhookManagerConfig,
    TwitchWebhookManagerConfig_Internal,
    GetOAuthTokenCallback,
    RefreshOAuthTokenCallback
}