/*
* Code for scheduling.
* The scheduling is for renewing subscriptions for long running servers.
* default scheduler is dumb as rocks, only using setTimeout. Better schedulers will need to take into account
* the deadline and twitch rate in order to better schedule renewals.
* */

import {Webhook} from "./webhooks";

type SchedulerMetaData = {
    runInterval: number; // Number of seconds between each run call. Infinity means to never run it.
}

//Some notes on this: addToScheduler will be called ONCE PER RENEWAL; It should not be on an interval basis, but just once.
// If it needs to be renewed again, addToScheduler will be called again.
// remove from scheduler should stop any renewal from occuring in the future.
interface WebhookRenewalScheduler {
    addToScheduler(webhook: Webhook): void; // Add webhook renewal to scheduler
    removeFromScheduler(webhook: Webhook): void; // Remove webhook renewal from scheduler
    getMetaData(): SchedulerMetaData;

    run(): void; // Run the scheduler at a pre defined interval.

    destroy(): void; //Stop all scheduling activities
}

class BasicWebhookRenewalScheduler implements WebhookRenewalScheduler {
    webhookURLToTimeout: Map<string, NodeJS.Timeout>;

    addToScheduler(webhook: Webhook): void {
        let resubHandler = () => {
            webhook.manager.resubscribe(webhook)
                .catch((e) => webhook.config.errorCallback(e));
            webhook.computeTopicUrl();
            this.webhookURLToTimeout.delete(webhook.computedTopicUrl)
        };

        webhook.computeTopicUrl();
        let timeout = setTimeout(resubHandler, (webhook.subscriptionEnd - Date.now()) * 750);
        this.webhookURLToTimeout.set(webhook.computedTopicUrl, timeout);
    }

    getMetaData(): SchedulerMetaData {
        return {
            runInterval: Infinity // Never run run()
        };
    }

    removeFromScheduler(webhook: Webhook): void {
        webhook.computeTopicUrl();
        clearTimeout(this.webhookURLToTimeout.get(webhook.computedTopicUrl));
        this.webhookURLToTimeout.delete(webhook.computedTopicUrl);
    }

    run(): void {}

    destroy(): void {
        this.webhookURLToTimeout.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.webhookURLToTimeout.clear();
    }

}

export {
    WebhookRenewalScheduler,
    BasicWebhookRenewalScheduler
}