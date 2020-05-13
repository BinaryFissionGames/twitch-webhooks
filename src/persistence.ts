import {
    TwitchWebhookManager,
    WebhookId,
    WebhookOptions,
    WebhookType,
    WebhookTypeEndpoint,
    WebhookTypeTopic
} from "./webhooks";
import * as crypto from "crypto";

type WebhookPersistenceObject = {
    id: WebhookId,
    type: WebhookType,
    href: string,
    subscribed: boolean,
    subscriptionStart ?: Date,
    subscriptionEnd ?: Date,
    secret: string,
    leaseSeconds: number
}

interface TwitchWebhookPersistenceManager {
    persistWebhook(webhook: WebhookPersistenceObject) : Promise<void>;
    saveWebhook(webhook: WebhookPersistenceObject) : Promise<void>;
    deleteWebhook(webhookId: WebhookId) : Promise<void>;
    getAllWebhooks() : Promise<WebhookPersistenceObject[]>;
    getWebhookById(webhookId: WebhookId) : Promise<WebhookPersistenceObject>;
    destroy(): Promise<void>;
}

class MemoryBasedTwitchWebhookPersistenceManager implements TwitchWebhookPersistenceManager {
    webhooks: Map<WebhookId, WebhookPersistenceObject> = new Map<string, WebhookPersistenceObject>();

    async deleteWebhook(webhookId: WebhookId): Promise<void> {
        this.webhooks.delete(webhookId);
    }

    async destroy(): Promise<void> {
        return this.webhooks.clear();
    }

    async getAllWebhooks(): Promise<WebhookPersistenceObject[]> {
        return Array.from(this.webhooks.values());
    }

    async getWebhookById(id: WebhookId): Promise<WebhookPersistenceObject | undefined> {
        return Object.assign({}, this.webhooks.get(id));
    }

    async persistWebhook(webhook: WebhookPersistenceObject): Promise<void> {
        return this.saveWebhook(webhook);
    }

    async saveWebhook(webhook: WebhookPersistenceObject): Promise<void> {
        this.webhooks.set(webhook.id, webhook);
    }
}

function createWebhookPersistenceObject(manager: TwitchWebhookManager, type: WebhookType, params: Map<string, string>,
                                        options: WebhookOptions) : WebhookPersistenceObject{
    let paramString = computeTopicParamString(params);
    let secret =  options.secret || manager.config.secret;
    let href = WebhookTypeTopic.get(type) + paramString;
    let hashedSecret = crypto.createHmac('sha256', secret).update(href).digest('hex');
    return {
        id: WebhookTypeEndpoint.get(type) + paramString,
        type: type,
        href: href,
        subscribed: false,
        secret: hashedSecret,
        leaseSeconds: options.leaseSeconds || 864000
    }
}

function getIdFromTypeAndParams(type: WebhookType, searchString: string){
    return WebhookTypeEndpoint.get(type) + searchString;
}

function computeTopicParamString(callbackUrlQueryParameters: Map<string, string>): string {
    let isFirst = true;
    let topicParams = '';

    //Note: These endpoints have the restriction that the query parameters must be sorted.
    //Because of this, we sort them here. This is also useful for us, since it means that each
    //set of query parameters will always be one string, regardless of how the parameters are added.
    let sortedParams = Array.from(callbackUrlQueryParameters.keys()).sort();
    for (let param_name of sortedParams) {
        let val = callbackUrlQueryParameters.get(param_name);
        topicParams += (isFirst ? '?' : '&') + `${param_name}=${encodeURIComponent(val)}`;
        isFirst = false;
    }
    return topicParams;
}

export {
    TwitchWebhookPersistenceManager,
    WebhookPersistenceObject,
    MemoryBasedTwitchWebhookPersistenceManager,
    getIdFromTypeAndParams,
    createWebhookPersistenceObject
}