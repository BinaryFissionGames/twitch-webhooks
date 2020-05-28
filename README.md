# twitch-webhooks

Library for subscribing to Twitch webhooks.

## Features
- Persistence support
- Rescheduling support
- Integrates with extraneous methods of getting Auth/Refresh tokens
- Integrates with an express application
- Written in TypeScript
## Installing
Run the command
`npm i @binaryfissiongames/twitch-webhooks`
 while in your project directory.
## Usage
```
    import {TwitchWebhookManager} from "@binaryfissiongames/twitch-webhooks";
    import express = require("express");

    const app = express();
    //Setup
    let webhookManager: TwitchWebhookManager = new TwitchWebhookManager({
        hostname: process.env.HOST_NAME, //Hostname for the server this is hosted on
        app: app, // Express application
        client_id: process.env.CLIENT_ID, // Twitch Client ID 
        base_path: 'webhooks', // base path to use on the express application for webhook endpoints
        getOAuthToken: getOAuthToken, // Async function to get OAuthToken from user ID
        refreshOAuthToken: refreshToken, // Function to refresh OAuth token from said OAuth token
        secret: 'supersecret' //If omitted, a cryptographically random secret will be generated
    });
    
    //setup message handler
    webhook.on('message', (type: WebhookType, webhookId: WebhookId, msg: WebhookPayload) => {
        console.log(`Got message: ${type} for webhook ${webhookId}, ${JSON.stringify(msg)}`);
    });
    
    //Set up error handler
    webhook.on('error', (e) => console.error(e))
    
    app.listen(8080).then(() => {
            //Subscribe to some endpoints
            let webhookId = await webhookManager.addUserFollowsSubscription({
                leaseSeconds: 6000, // Can be up to 864000 (default, 10 days),
                secret: 'thisiswebhookspecificsecret' //If omitted, the webhook manager secret is used.
            }, 1002 /*to_id*/);
            
            /* Code goes here */
            
            await webhookManager.unsubscribe(webhookId);
            //OR
            await webhookManager.unsubFromAll();
            
            //Destroy all owned resources (timers, persistence manager, renewal scheduler)
            //Note: As of writing this, this manager may still receive messages after destruction,
            //depending on the persistence manager implementation, AND if the underlying http(s) server is not closed.
            await webhookManager.destroy();
    });
```

## Persistence
A specific persistence implementation is defined through the `TwitchWebhookPersistenceManager` (see `persistence.ts`) interface.
An instance of an implementation may be provided to the `TwitchWebhookManager`'s constructor as the `persistenceManager` property.
In the case that NO such persistence manager is provided - a default, ***IN-MEMORY*** persistence manager is used. This means data about your
webhooks will not persist between restarts, and could lead to twitch attempting to contact a down server
if the server shuts down without properly unsubscribing from endpoints.

## Rescheduling
Rescheduling is defined through the `WebhookRenewalScheduler` interface (see `scheduling.ts`).
If no scheduler is provided during construction of the `TwitchWebhookManager` as the `renewalScheduler` property,
then webhooks ***WILL NOT*** be renewed. A simple, default implementation is provided with the library,
(see `BasicWebhookRenewalScheduler` in `scheduling.ts`). This implementation will attempt to renew a webhook
after 85% of it's time from start to expiry has occurred. Smarter logic can be substituted by implementing
the `WebhookRenewalScheduler` interface.

## Example(s)

As of right now, [this repo](https://github.com/Denu8thell/twitch-webhooks-test) is the best example
I can give of a larger application. The code needs major cleaning up to be readable, but it might be the best bet in terms
of seeing "working" code. This example takes advantage of persistence using [Sequelize](https://github.com/sequelize/sequelize), which may be of
interest.

TODO: 
- More documentation
- Better typing (enum types and all that for twitch events - need to research the endpoints in practice, since the docs are NOT clear.)
- Tests (currently working on this)