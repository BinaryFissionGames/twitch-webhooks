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
import {
    MemoryBasedTwitchWebhookPersistenceManager,
    TwitchWebhookPersistenceManager,
    WebhookPersistenceObject
} from "../persistence";
import {BasicWebhookRenewalScheduler, IResubscribeable} from "../scheduling";
import {EventEmitter} from "events";
import deepEqual = require("deep-equal");


const webhookSubscriberPort = 3080;
const webhookSubscriberUrl = `http://localhost:${webhookSubscriberPort}`;
const webhookHubPort = 3090;
const webhookHubUrl = `http://localhost:${webhookHubPort}/hub`;

describe('Twitch Webhooks', function () {
    describe('In-memory Persistence Manager', function () {
        it('Allows persisted information to be retrieved', async function () {
            let persistenceManager = new MemoryBasedTwitchWebhookPersistenceManager();
            let persistenceObject: WebhookPersistenceObject = {
                href: "http://localhost/webhook",
                id: "webhookid",
                leaseSeconds: 2,
                secret: "secret",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 2000),
                subscriptionStart: new Date(),
                type: WebhookType.UserFollows
            };

            await persistenceManager.persistWebhook(persistenceObject);
            assert.deepStrictEqual(persistenceObject, await persistenceManager.getWebhookById(persistenceObject.id))
        });

        it('Allows persisted information to be updated', async function () {
            let persistenceManager = new MemoryBasedTwitchWebhookPersistenceManager();
            let originalPersistenceObject: WebhookPersistenceObject = {
                href: "http://localhost/webhook",
                id: "webhookid",
                leaseSeconds: 2,
                secret: "secret",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 2000),
                subscriptionStart: new Date(),
                type: WebhookType.UserFollows
            };

            await persistenceManager.persistWebhook(originalPersistenceObject);

            let newPersistenceObject = Object.assign({}, originalPersistenceObject);
            newPersistenceObject.subscribed = true;
            newPersistenceObject.leaseSeconds = 1;
            newPersistenceObject.subscriptionStart = new Date();
            newPersistenceObject.subscriptionEnd = new Date(Date.now() + 1000);

            await persistenceManager.saveWebhook(newPersistenceObject);
            assert.deepStrictEqual(newPersistenceObject, await persistenceManager.getWebhookById(originalPersistenceObject.id))
        });

        it('Allows multiple objects to be saved and have them retrieved through getAll', async function () {
            let persistenceManager = new MemoryBasedTwitchWebhookPersistenceManager();
            let objects: WebhookPersistenceObject[] = [{
                href: "http://localhost/webhook",
                id: "webhookid",
                leaseSeconds: 1,
                secret: "secret1",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 1000),
                subscriptionStart: new Date(),
                type: WebhookType.UserFollows
            }, {
                href: "http://localhost/webhook",
                id: "webhookid2",
                leaseSeconds: 2,
                secret: "secret2",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 2000),
                subscriptionStart: new Date(),
                type: WebhookType.UserFollows
            }, {
                href: "http://localhost/webhook",
                id: "webhookid3",
                leaseSeconds: 3,
                secret: "secret3",
                subscribed: true,
                subscriptionEnd: new Date(Date.now() + 3000),
                subscriptionStart: new Date(),
                type: WebhookType.StreamChanged
            }, {
                href: "http://localhost/webhook",
                id: "webhookid4",
                leaseSeconds: 4,
                secret: "secret4",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 4000),
                subscriptionStart: new Date(),
                type: WebhookType.UserChanged
            }];

            for (let webhook of objects) {
                await persistenceManager.saveWebhook(webhook);
            }

            let savedObjects = await persistenceManager.getAllWebhooks();

            assert.strictEqual(savedObjects.length, objects.length);

            for (let webhook of objects) {
                let exists = false;
                for (let savedWebhook of savedObjects) {
                    if (deepEqual(savedWebhook, webhook)) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    throw new Error('Could not find webhook object with ID ' + webhook.id);
                }
            }
        });

        it('Properly deletes a webhook', async function () {
            let persistenceManager = new MemoryBasedTwitchWebhookPersistenceManager();
            let persistenceObject: WebhookPersistenceObject = {
                href: "http://localhost/webhook",
                id: "webhookid",
                leaseSeconds: 2,
                secret: "secret",
                subscribed: false,
                subscriptionEnd: new Date(Date.now() + 2000),
                subscriptionStart: new Date(),
                type: WebhookType.UserFollows
            };

            await persistenceManager.persistWebhook(persistenceObject);
            assert.deepStrictEqual(persistenceObject, await persistenceManager.getWebhookById(persistenceObject.id));
            await persistenceManager.deleteWebhook(persistenceObject.id);
            assert.deepStrictEqual(await persistenceManager.getWebhookById(persistenceObject.id), undefined);
        });
    });

    describe('Default Renewal Scheduler', function () {
        class TestResubscribeable extends EventEmitter implements IResubscribeable {
            async resubscribePersistenceObject(webhook: WebhookPersistenceObject): Promise<void> {
                this.emit('resubCalled', webhook);
            }
        }

        it('Resubs before the webhook expires', async function () {
            this.timeout(10000);
            this.slow(2000);
            return new Promise((resolve, reject) => {
                let rescheduler = new BasicWebhookRenewalScheduler();
                let resubscribable = new TestResubscribeable();
                let now = Date.now();

                let persistenceObject: WebhookPersistenceObject = {
                    href: "/webhook?to_id=somethign",
                    id: 'webhookid',
                    leaseSeconds: 2,
                    secret: "secret",
                    subscribed: true,
                    type: WebhookType.UserFollows,
                    subscriptionStart: new Date(now),
                    subscriptionEnd: new Date(now + 2000)
                };

                resubscribable.on('resubCalled', (webhook: WebhookPersistenceObject) => {
                    try {
                        assert.ok(webhook.subscriptionEnd && webhook.subscriptionEnd > new Date());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });

                rescheduler.setResubscribeableObject(resubscribable);
                rescheduler.addToScheduler(persistenceObject);

            });
        });

        it('Resubs immediately if the webhook is already expired', async function () {
            this.timeout(10000);
            this.slow(2000);
            return new Promise((resolve, reject) => {
                let rescheduler = new BasicWebhookRenewalScheduler();
                let resubscribable = new TestResubscribeable();
                let now = Date.now();

                let persistenceObject: WebhookPersistenceObject = {
                    href: "/webhook?to_id=somethign",
                    id: 'webhookid',
                    leaseSeconds: 2,
                    secret: "secret",
                    subscribed: true,
                    type: WebhookType.UserFollows,
                    subscriptionStart: new Date(now - 3000),
                    subscriptionEnd: new Date(now - 1000)
                };

                resubscribable.on('resubCalled', (_: WebhookPersistenceObject) => {
                    try {
                        assert.ok(Date.now() < now + 100);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });

                rescheduler.setResubscribeableObject(resubscribable);
                rescheduler.addToScheduler(persistenceObject);

            });
        });

        it('Does not resub twice', async function () {
            this.timeout(10000);
            this.slow(5000);
            return new Promise((resolve, reject) => {
                let rescheduler = new BasicWebhookRenewalScheduler();
                let resubscribable = new TestResubscribeable();
                let now = Date.now();

                let persistenceObject: WebhookPersistenceObject = {
                    href: "/webhook?to_id=somethign",
                    id: 'webhookid',
                    leaseSeconds: 1,
                    secret: "secret",
                    subscribed: true,
                    type: WebhookType.UserFollows,
                    subscriptionStart: new Date(now),
                    subscriptionEnd: new Date(now + 1000)
                };

                let timesCalled = 0;
                resubscribable.on('resubCalled', (webhook: WebhookPersistenceObject) => {
                    try {
                        assert.ok(webhook.subscriptionEnd && webhook.subscriptionEnd > new Date());
                        timesCalled++;
                    } catch (e) {
                        reject(e);
                    }
                });

                rescheduler.setResubscribeableObject(resubscribable);
                rescheduler.addToScheduler(persistenceObject);

                setTimeout(() => {
                    try {
                        assert.strictEqual(timesCalled, 1);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }, 2000);

            });
        });

        it('Properly removes a resubscription', async function () {
            this.timeout(10000);
            this.slow(5000);
            return new Promise((resolve, reject) => {
                let rescheduler = new BasicWebhookRenewalScheduler();
                let resubscribable = new TestResubscribeable();
                let now = Date.now();

                let persistenceObject: WebhookPersistenceObject = {
                    href: "/webhook?to_id=somethign",
                    id: 'webhookid',
                    leaseSeconds: 1,
                    secret: "secret",
                    subscribed: true,
                    type: WebhookType.UserFollows,
                    subscriptionStart: new Date(now),
                    subscriptionEnd: new Date(now + 1000)
                };

                let timesCalled = 0;
                resubscribable.on('resubCalled', (webhook: WebhookPersistenceObject) => {
                    try {
                        assert.ok(webhook.subscriptionEnd && webhook.subscriptionEnd > new Date());
                        timesCalled++;
                    } catch (e) {
                        reject(e);
                    }
                });

                rescheduler.setResubscribeableObject(resubscribable);
                rescheduler.addToScheduler(persistenceObject);
                rescheduler.removeFromScheduler(persistenceObject.id);

                setTimeout(() => {
                    try {
                        assert.strictEqual(timesCalled, 0);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }, 2000);

            });
        });

        it('Destroy properly stops resubscriptions from occuring', async function () {
            this.timeout(10000);
            this.slow(5000);
            return new Promise(async (resolve, reject) => {
                let rescheduler = new BasicWebhookRenewalScheduler();
                let resubscribable = new TestResubscribeable();
                let now = Date.now();

                let persistenceObject: WebhookPersistenceObject = {
                    href: "/webhook?to_id=somethign",
                    id: 'webhookid',
                    leaseSeconds: 1,
                    secret: "secret",
                    subscribed: true,
                    type: WebhookType.UserFollows,
                    subscriptionStart: new Date(now),
                    subscriptionEnd: new Date(now + 1000)
                };

                let timesCalled = 0;
                resubscribable.on('resubCalled', (webhook: WebhookPersistenceObject) => {
                    try {
                        assert.ok(webhook.subscriptionEnd && webhook.subscriptionEnd > new Date());
                        timesCalled++;
                    } catch (e) {
                        reject(e);
                    }
                });

                rescheduler.setResubscribeableObject(resubscribable);
                rescheduler.addToScheduler(persistenceObject);
                await rescheduler.destroy();

                setTimeout(() => {
                    try {
                        assert.strictEqual(timesCalled, 0);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }, 2000);

            });
        });
    });

    describe('Webhook Subscription/Unsubscription', function () {
        let manager: TwitchWebhookManager | undefined;
        let webhookServer: http.Server | undefined;
        let persistenceManager: TwitchWebhookPersistenceManager | undefined;

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

            persistenceManager = new MemoryBasedTwitchWebhookPersistenceManager();
            manager = new TwitchWebhookManager({
                hostname: webhookSubscriberUrl,
                app,
                client_id: 'test_client_id',
                getOAuthToken: async (_) => 'oauth',
                refreshOAuthToken: async (_) => 'oauth',
                base_path: 'webhooks',
                hubUrl: webhookHubUrl,
                persistenceManager: persistenceManager,
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
            persistenceManager = undefined;
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
                await manager.addUserFollowsSubscription({}, {
                    to_id: '1'
                });
                await manager.addStreamChangedSubscription({}, {
                    user_id: '1'
                });
                await manager.addUserChangedSubscription({}, {
                    user_id: '1'
                });
                await manager.addExtensionTransactionCreatedSubscription({}, {
                    extension_id: '12'
                });
                await manager.addChannelBanChangedSubscription({}, {
                    broadcaster_id: '1'
                });
                await manager.addModeratorChangedSubscription({}, {
                    broadcaster_id: '1'
                });
                await manager.addSubscriptionSubscription({}, {
                    broadcaster_id: '1'
                });
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

                            assert.deepStrictEqual(payload.data, followEvent.data);
                            assert.deepEqual(payload.subParams, {
                                to_id: '1',
                                from_id: undefined
                            });
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

                    let subId = await manager.addUserFollowsSubscription({}, {
                        to_id: '1'
                    });
                } else {
                    reject(new Error('Manager is undefined'));
                }
            });
        });

        it('Properly deletes webhook after unsubscribed', async function () {

            let subId: WebhookId | undefined = undefined;
            return new Promise(async (resolve, reject) => {
                if (manager && persistenceManager) {
                    manager.on('subscribed', () => {
                        //Unsub
                        if (manager && subId) {
                            manager.unsubscribe(subId);
                        } else {
                            reject(new Error('Manager or subId is undefined'));
                        }
                    });

                    manager.on('unsubscribed', async (webhookId: WebhookId) => {
                        try {
                            assert.strictEqual(subId, webhookId);
                            if (persistenceManager) {
                                assert.strictEqual(await persistenceManager.getWebhookById(webhookId), undefined);
                                resolve();
                            } else {
                                reject(new Error('Persistence manager not defined'));
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });


                    subId = await manager.addUserFollowsSubscription({}, {
                        to_id: '1'
                    });
                } else {
                    reject(new Error('Manager is undefined'));
                }
            });
        });

        it('Allows multiple subscriptions to be made with the same parameters', async function () {
            if (manager) {
                let subId = await manager.addUserFollowsSubscription({}, {
                    to_id: '1'
                });

                let secondSubId = await manager.addUserFollowsSubscription({}, {
                    to_id: '1'
                });

                assert.strictEqual(subId, secondSubId);
            }
        });

        it('Properly unsubscribes from all webhooks', async function () {
            if (manager && persistenceManager) {
                await manager.addUserFollowsSubscription({}, {
                    to_id: '1'
                });
                await manager.addStreamChangedSubscription({}, {
                    user_id: '1'
                });
                await manager.addUserChangedSubscription({}, {
                    user_id: '1'
                });
                await manager.addExtensionTransactionCreatedSubscription({}, {
                    extension_id: '12'
                });
                await manager.addChannelBanChangedSubscription({}, {
                    broadcaster_id: '1'
                });
                await manager.addModeratorChangedSubscription({}, {
                    broadcaster_id: '1'
                });
                await manager.addSubscriptionSubscription({}, {
                    broadcaster_id: '1'
                });

                await manager.unsubFromAll();
                assert.deepStrictEqual((await persistenceManager.getAllWebhooks()).length, 0);
            } else {
                throw new Error('Manager is undefined');
            }
        });
    });
});