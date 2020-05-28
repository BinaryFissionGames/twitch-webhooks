import {TwitchWebhookManager, WebhookId} from "../webhooks";
import {WebhookType as ThisProjectWebhookType} from '../config';
import * as express from 'express';
import {
    clearDb,
    closeMockServer,
    emitEvent,
    setUpMockWebhookServer,
    WebhookEvent,
    WebhookType
} from "twitch-mock-webhook-hub";
import * as http from 'http';
import * as assert from 'assert';

const webhookSubscriberPort = 3080;
const webhookSubscriberUrl = `http://localhost:${webhookSubscriberPort}`;
const webhookHubPort = 3090;
const webhookHubUrl = `http://localhost:${webhookHubPort}/hub`;

describe('Twitch Webhooks', function () {
    describe('In-memory Persistence Manager', function () {

    });

    describe('Default Renewal Scheduler', function () {

    });

    describe('Webhook Subscription/Unsubscription', function () {
        let manager: TwitchWebhookManager | undefined;
        let webhookServer: http.Server | undefined;

        this.slow(5000);
        this.timeout(15000);

        before(async function () {
            await setUpMockWebhookServer({
                hub_url: webhookHubUrl,
                logErrors: true,
                //verbose: true,
                port: webhookHubPort,
                pollTimerMs: 1000
            });
            await clearDb();
        });

        beforeEach(function () {
            const app = express();
            manager = new TwitchWebhookManager({
                hostname: webhookSubscriberUrl,
                app,
                client_id: 'test_client_id',
                getOAuthToken: async (_) => 'oauth',
                refreshOAuthToken: async (_) => 'oauth',
                base_path: 'webhooks',
                hubUrl: webhookHubUrl,
                /*logger: {
                    info: ((message, ...args) => console.info('[INFO][TwitchWebhookManager] ' + message, ...args)),
                    debug: ((message, ...args) => console.debug('[DEBUG][TwitchWebhookManager] ' + message, ...args)),
                    error: ((message, ...args) => console.error('[ERROR][TwitchWebhookManager] ' + message, ...args))
                }*/
            });

            return new Promise((resolve, _) => {
                webhookServer = app.listen(webhookSubscriberPort, resolve);
            });
        });

        afterEach(async function () {
            await clearDb();
            if (manager) {
                await manager.destroy();
            }
            manager = undefined;
            return new Promise((resolve, reject) => {
                if (webhookServer) {
                    webhookServer.close((e) => {
                        webhookServer = undefined;
                        if (e) {
                            return reject(e);
                        }
                        return resolve();
                    });
                }
            });
        });

        after(async function () {
            await closeMockServer(true);
        });

        it("Doesn't error when subscribing to each endpoint", async function () {
            if (manager) {
                await manager.addUserFollowsSubscription({}, '1');
                await manager.addStreamChangedSubscription({}, '1');
                await manager.addUserChangedSubscription({}, '1');
                await manager.addExtensionTransactionCreatedSubscription({}, '12');
                await manager.addChannelBanChangedEvent({}, '1');
                await manager.addModeratorChangedEvent({}, '1');
                await manager.addSubscriptionEvent({}, '1');
            } else {
                throw new Error('Manager is undefined');
            }
        });

        it("Receives a message when it is emitted", async function () {

            let followEvent: WebhookEvent<WebhookType.UserFollows> = {
                type: WebhookType.UserFollows,
                data: {
                    to_id: '1',
                    to_name: 'test_user',
                    from_id: '2',
                    from_name: 'test_follower',
                    followed_at: new Date()
                }
            };

            return new Promise(async (resolve, reject) => {
                if (manager) {
                    manager.on('error', reject);

                    manager.on('message', (webhookId, payload) => {
                        try {
                            if (payload.type != ThisProjectWebhookType.UserFollows) {
                                // noinspection ExceptionCaughtLocallyJS
                                throw new Error(`Expected type ${ThisProjectWebhookType.UserFollows}, but got ${payload.type}`);
                            }

                            assert.deepStrictEqual(payload.data, followEvent.data, new Error('Got event does not match the emitted event!'));
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });

                    manager.on('subscribed', (id: WebhookId) => {
                        if (subId !== id) {
                            reject(new Error("Got subscribed ID for a webhook that we didn't subscribe to!"));
                        }
                        emitEvent(followEvent).catch(reject);
                    });

                    let subId = await manager.addUserFollowsSubscription({}, '1');
                } else {
                    reject(new Error('Manager is undefined'));
                }
            });
        });
    });
});