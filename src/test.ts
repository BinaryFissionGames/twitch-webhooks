import {refreshToken, setupTwitchOAuthPath} from "twitch-oauth-authorization-code-express";
import express = require("express");
import * as session from "express-session";
import {SessionOptions} from "express-session";
import {TwitchWebhookManager} from "./webhooks";
import * as https from 'https';

/*
* A VERY simple test of a subscription to the follow endpoint.
* */

const app = express();
let sess : SessionOptions = {
    secret: process.env.SESSION_SECRET
};

app.use(session(sess)); // Need to set up session middleware!

setupTwitchOAuthPath({
    app: app, // The express app
    callback: ((req, res, info) =>  {
        req.session.access_token = info.access_token;
        req.session.refresh_token = info.refresh_token;
        res.redirect(307, "/success");
        res.end();
    }), // Callback when oauth info is gotten. Session info should be used
    client_id: process.env.CLIENT_ID, // Twitch client ID
    client_secret: process.env.CLIENT_SECRET, // Twitch client secret
    force_verify: true, // If true, twitch will always ask the user to verify. If this is false, if the app is already authorized, twitch will redirect immediately back to the redirect uri
    redirect_uri: process.env.REDIRECT_URI, // URI to redirect to (this is the URI on this server, so the path defines the endpoint!)
    scopes: ['channel:read:subscriptions', 'user:read:email'] // List of scopes your app is requesting access to
});

let webhookManager : TwitchWebhookManager = new TwitchWebhookManager({
    hostname: process.env.HOST_NAME,
    app: app,
    client_id: process.env.CLIENT_ID,
    base_path: 'webhooks'
});

app.get('/success', (req, res) => {
    res.end("Auth token: " + req.session.access_token + ", Refresh token: " + req.session.refresh_token);

    let httpsReq = https.request("https://id.twitch.tv/oauth2/validate", {
        headers: {
            "Authorization": `OAuth ${req.session.access_token}`,
            "Client-ID": process.env.CLIENT_ID,
        }
    }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
            body += chunk;
            console.log("Chunk: " + chunk);
        });

        res.on('end', () => {
            let jsonBody = JSON.parse(body);
            let token = req.session.access_token;
            let refresh_token = req.session.refresh_token;

            webhookManager.addUserFollowsSubscription({
                errorCallback: e => console.error(e),
                onReceivedCallback: msg => {console.log("Got sub message!"); console.log(msg)},
                getOAuthToken: async () => token,
                refreshOAuthToken: async () => await (refreshToken(refresh_token, process.env.CLIENT_ID, process.env.CLIENT_SECRET)
                    .then((tokenInfo) => {
                        token = tokenInfo.access_token;
                        refresh_token = tokenInfo.refresh_token;
                        return token
                    }))
            }, jsonBody.user_id.toString()).then(()=>{
                console.log("Listening for follow messages!");
            }).catch((e) => {
                console.error(e);
            });
        })
    });

    httpsReq.on('error', ()=>{
        console.error("Failed to call validate endpoint.");
    });

    httpsReq.end();

});

app.get('/refresh', (req, res) => {
    //This endpoint will use the refresh token to refresh the OAuth token.
    refreshToken(req.session.refresh_token, process.env.CLIENT_ID, process.env.CLIENT_SECRET).then((tokenInfo) => {
        req.session.access_token = tokenInfo.access_token;
        req.session.refresh_token = tokenInfo.refresh_token;
        res.end("New auth token: " + req.session.access_token + ", New refresh token: " + req.session.refresh_token);
    });
});

app.listen(3080, function(){
    console.log("Listening on port 3080");
});