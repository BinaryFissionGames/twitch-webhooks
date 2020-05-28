import {WebhookType, WebhookTypeEndpoint} from "./config";
import {WebhookPersistenceObject} from "./persistence";
import {TwitchWebhookManager, WebhookId} from "./webhooks";
import {
    ChannelBanChangedSubParams,
    ExtensionTransactionCreatedSubParams, ModeratorChangedSubParams,
    StreamChangedSubParams, SubscriptionSubParams,
    UserChangedSubParams,
    UserFollowsSubParams
} from "./payload_types";

const TIMESTAMP_REGEX = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)\.(\d+)Z$/;

//Parses date from unix timestamp; Returns undefined if the date cannot be parsed.
function unixTimestampToDate(timestamp: string): Date | undefined {
    let match = TIMESTAMP_REGEX.exec(timestamp);
    if (match) {
        let year = parseInt(match[1]);
        let month = parseInt(match[2]);
        let day = parseInt(match[3]);
        let hour = parseInt(match[4]);
        let minutes = parseInt(match[5]);
        let seconds = parseInt(match[6]);
        let milliseconds = parseInt(match[7]);
        return new Date(Date.UTC(year, month - 1, day, hour, minutes, seconds, milliseconds));
    }
    return undefined;
}

function getEndpointPath(basePath: string | undefined, webhookType: WebhookType): string {
    let normalizedBasePath: string;

    if (basePath) {
        normalizedBasePath = "/" + basePath;
    } else {
        normalizedBasePath = "";
    }
    return `${normalizedBasePath}/${WebhookTypeEndpoint.get(Number(webhookType))}`;
}

function getCallbackUrl(manager: TwitchWebhookManager, webhook: WebhookPersistenceObject): string {
    return manager.config.hostname + getEndpointPath(manager.config.base_path, webhook.type) + new URL(webhook.href).search;
}

//Gets the params passed to create the webhook
//Copious use of ts-ignore, because I don't think there's a way to get this signature to actually work with
//the body.
function getWebhookParamsFromId<T extends WebhookType>(type: T, webhookId: WebhookId): T extends WebhookType.UserFollows ? UserFollowsSubParams :
    T extends WebhookType.StreamChanged ? StreamChangedSubParams :
        T extends WebhookType.UserChanged ? UserChangedSubParams :
            T extends WebhookType.ExtensionTransactionCreated ? ExtensionTransactionCreatedSubParams :
                T extends WebhookType.ModeratorChange ? ModeratorChangedSubParams :
                    T extends WebhookType.ChannelBanChange ? ChannelBanChangedSubParams :
                        T extends WebhookType.Subscription ? SubscriptionSubParams :
                            any {
    let params = new URLSearchParams(webhookId.substring(webhookId.indexOf('?')));
    switch (type) {
        case WebhookType.UserFollows:
            // @ts-ignore
            return {
                to_id: params.get('to_id') || undefined,
                from_id: params.get('from_id') || undefined
            };
        case WebhookType.StreamChanged:
            // @ts-ignore
            return {
                user_id: params.get('user_id')
            };
        case WebhookType.UserChanged:
            // @ts-ignore
            return {
                user_id: params.get('id')
            };
        case WebhookType.ExtensionTransactionCreated:
            // @ts-ignore
            return {
                extension_id: params.get('extension_id')
            };
        case WebhookType.ModeratorChange:
            // @ts-ignore
            return {
                broadcaster_id: params.get('broadcaster_id'),
                user_id: params.get('user_id') || undefined
            };
        case WebhookType.ChannelBanChange:
            // @ts-ignore
            return {
                broadcaster_id: params.get('broadcaster_id'),
                user_id: params.get('user_id') || undefined
            };
        case WebhookType.Subscription:
            // @ts-ignore
            return {
                broadcaster_id: params.get('broadcaster_id'),
                user_id: params.get('user_id') || undefined,
                gifter_id: params.get('gifter_id') || undefined,
                gifter_name: params.get('gifter_name') || undefined
            };
        default:
            // @ts-ignore
            return {};
    }
}

export {
    unixTimestampToDate,
    getEndpointPath,
    getCallbackUrl,
    getWebhookParamsFromId
}