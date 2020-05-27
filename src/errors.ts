import {IncomingMessage} from 'http'
import {WebhookPersistenceObject} from "./persistence";
import {unixTimestampToDate} from "./util";

class TwitchRequestError extends Error {
    statusCode: number;
    headers: { [key: string]: any };
    twitchError: string;
    twitchMessage: string;

    constructor(statusCode: number, headers: { [key: string]: any }, message: string, responseBody: { [key: string]: any }) {
        super(message);
        this.statusCode = statusCode;
        this.headers = headers;
        if (responseBody["error"]) {
            this.twitchError = responseBody["error"];
        }
        if (responseBody["message"]) {
            this.twitchMessage = responseBody["message"];
        }
    }
}

class UnauthorizedTwitchRequestError extends TwitchRequestError {
    authenticateError: string;

    constructor(headers: { [key: string]: any }, responseBody: { [key: string]: any }) {
        super(401, headers, "OAuth token was rejected (after a refresh attempted).", responseBody);
        let authHeader = headers["WWW-Authenticate"];
        let headerParams: any = {};
        authHeader.split(',').forEach((str: string) => {
            let sides = str.split('=');
            if (sides.length == 2) {
                headerParams[sides[0].trim()] = sides[1].substring(1, sides[1].length - 1);
            }
        });

        if (headerParams['error']) {
            this.authenticateError = headerParams['error'];
        }
    }
}


class RateLimitHitTwitchRequestError extends TwitchRequestError {
    refillRate: number;
    limitReset: Date;

    constructor(headers: { [key: string]: any }, responseBody: { [key: string]: any }) {
        super(429, headers, "Rate limit hit; Wait for bucket to refill to make more requests!", responseBody);
        this.refillRate = Number.parseInt(headers["ratelimit-limit"]);
        this.limitReset = unixTimestampToDate(headers["ratelimit-reset"]) || new Date(0);
        if (!this.limitReset) {
            console.error("While creating rate limit error, couldn't parse timestamp!");
            this.limitReset = new Date(0);
        }
    }
}

function createErrorFromResponse(res: IncomingMessage, body: string): TwitchRequestError | undefined {
    if (res.statusCode && Math.floor(res.statusCode / 100) == 2) {
        return undefined;
    }
    let headers: { [key: string]: string } = {};
    res.rawHeaders.forEach((val, index) => {
        if (index % 2 == 1) return;
        headers[val.toLowerCase()] = res.rawHeaders[index + 1];
    });

    let bodyJson: { [key: string]: string } = {};
    try {
        bodyJson = JSON.parse(body);
    } catch (e) {
        //ignore error - we're already handling an error!
    }
    switch (res.statusCode) {
        case 401:
            return new UnauthorizedTwitchRequestError(headers, bodyJson);
        case 429:
            return new RateLimitHitTwitchRequestError(headers, bodyJson);
        default:
            return new TwitchRequestError(res.statusCode || 0, headers,
                bodyJson['message'] || 'Failed to make a twitch request!', bodyJson);
    }
}

class SubscriptionDeniedError extends Error {
    webhook: WebhookPersistenceObject;
    reason?: string;

    constructor(webhook: WebhookPersistenceObject, reason?: string) {
        super(`Subscription denied for webhook ${webhook.id}`);
        this.webhook = webhook;
        this.reason = reason;
    }
}

export {
    createErrorFromResponse,
    TwitchRequestError,
    RateLimitHitTwitchRequestError,
    UnauthorizedTwitchRequestError,
    SubscriptionDeniedError
}