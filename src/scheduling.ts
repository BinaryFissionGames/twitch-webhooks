/*
* Code for scheduling.
* The scheduling is for renewing subscriptions for long running servers.
* default scheduler is dumb as rocks, only using setTimeout. Better schedulers will need to take into account
* the deadline and twitch rate in order to better schedule renewals.
* */

import {WebhookId} from "./webhooks";
import {WebhookPersistenceObject} from "./persistence";
import EventEmitter = NodeJS.EventEmitter;

type SchedulerMetaData = {
    runInterval: number; // Number of seconds between each run call. Infinity means to never run it.
}

//Some notes on this: addToScheduler will be called ONCE PER RENEWAL; It should not be on an interval basis, but just once.
// If it needs to be renewed again, addToScheduler will be called again.
// remove from scheduler should stop any renewal from occuring in the future.
interface WebhookRenewalScheduler {
    setResubscribeableObject(resubscribeable: IResubscribeable): void;

    addToScheduler(webhook: WebhookPersistenceObject): void; // Add webhook renewal to scheduler
    removeFromScheduler(webhook: WebhookId): void; // Remove webhook renewal from scheduler
    getMetaData(): SchedulerMetaData;

    run(): void; // Run the scheduler at a pre defined interval.

    destroy(): Promise<void>; //Stop all scheduling activities
}

interface IResubscribeable extends EventEmitter {
    resubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void>;
}

class BasicWebhookRenewalScheduler implements WebhookRenewalScheduler {
    webhookURLToTimeout: Map<string, NodeJS.Timeout> = new Map<string, NodeJS.Timeout>();
    resubscribeable: IResubscribeable;

    setResubscribeableObject(resubscribeable: IResubscribeable) {
        this.resubscribeable = resubscribeable;
    }

    addToScheduler(webhook: WebhookPersistenceObject): void {
        let resubHandler = () => {
            //TODO: Flesh out error stuff for this
            this.resubscribeable.resubscribePersistenceObject(webhook)
                .catch((e) => this.resubscribeable.emit('error', e, webhook.id));
            this.webhookURLToTimeout.delete(webhook.id);
        };

        // Note about types here; If subscribed = true (that is, we are adding it to this scheduler),
        // then the subscription start and end MUST be defined.
        //TODO? Might want to find a way to enforce this through the type system.
        let timeToResub = (((<Date>webhook.subscriptionEnd).getTime() - (<Date>webhook.subscriptionStart).getTime()) - (Date.now() - (<Date>webhook.subscriptionStart).getTime())) * 0.85;
        if (timeToResub <= 0) {
            setImmediate(resubHandler);
        } else {
            let timeout = setTimeout(resubHandler, timeToResub);
            this.webhookURLToTimeout.set(webhook.id, timeout);
        }
    }

    getMetaData(): SchedulerMetaData {
        return {
            runInterval: Infinity // Never run run()
        };
    }

    removeFromScheduler(webhook: WebhookId): void {
        if (this.webhookURLToTimeout.get(webhook)) {
            clearTimeout(<NodeJS.Timeout>this.webhookURLToTimeout.get(webhook));
        }
        this.webhookURLToTimeout.delete(webhook);
    }

    run(): void {
    }

    async destroy(): Promise<void> {
        this.webhookURLToTimeout.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.webhookURLToTimeout.clear();
    }

}

export {
    WebhookRenewalScheduler,
    BasicWebhookRenewalScheduler,
    IResubscribeable
}