/*
This is a sample bot application for RingCentral. Learn more about this
app by following the instructions found at the URL below:
https://developers.ringcentral.com/guide/team-messaging/bots/walkthrough/

Copyright: 2021 - RingCentral, Inc.
License: MIT
*/
require('dotenv').config();

var RingCentral = require('@ringcentral/sdk').SDK;

var express = require('express');
var bp      = require('body-parser')
var fs      = require('fs');

// read in config parameters from environment, or .env file
const PORT            = process.env.PORT;
const RINGCENTRAL_CLIENT_ID       = process.env.RINGCENTRAL_CLIENT_ID;
const RINGCENTRAL_CLIENT_SECRET   = process.env.RINGCENTRAL_CLIENT_SECRET;
const RINGCENTRAL_SERVER_URL = process.env.RINGCENTRAL_SERVER_URL;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI
const WEBHOOKS_DELIVERY_ADDRESS = process.env.WEBHOOKS_DELIVERY_ADDRESS

const TOKEN_TEMP_FILE = '.bot-auth';
const SUBSCRIPTION_ID_TEMP_FILE = '.bot-subscription';

var app = express();
var platform, subscription, rcsdk, subscriptionId, bot_token;

app.use( bp.json() );
app.use( bp.urlencoded({
  extended: true
}));

// Start our server
app.listen(PORT, function () {
    console.log("Bot server listening on port " + PORT);
    loadSavedTokens()
});

// This route handles GET requests to our root ngrok address and responds
// with the same "Ngrok is working message"
app.get('/', function(req, res) {
    res.send('Ngrok is working! Path Hit: ' + req.url);
});

// Instantiate the RingCentral JavaScript SDK
var rcsdk = new RingCentral({
  server: RINGCENTRAL_SERVER_URL,
  clientId: RINGCENTRAL_CLIENT_ID,
  clientSecret: RINGCENTRAL_CLIENT_SECRET,
  redirectUri: OAUTH_REDIRECT_URI
});

var platform = rcsdk.platform();

async function loadSavedTokens(){
  if (fs.existsSync( TOKEN_TEMP_FILE )) {
    var savedTokens = JSON.parse( fs.readFileSync( TOKEN_TEMP_FILE ) );
    console.log( "Reusing saved access token")
    await platform.auth().setData( savedTokens );
    checkWebhooksSubscription()
  }else{
    console.log("Your bot has not been installed or the saved access token was lost!")
    console.log("Login to developers.ringcentral.com, open the bot app and install it by selecting \
the Bot menu and at the 'General Settings' section, click the 'Add to RingCentral' button.")
    console.log("Note: If the bot was installed, remove it and reinstall to get a new access token")
  }
}

// Handle authorization for public bots
//
// When a public bot is installed, RingCentral sends an authorization code
// via an HTTP GET to the specified redirect url. When the bot receives
// the authorization code, it uses the code to exchange for the access token.

// Then the bot subscribes to Webhooks so that it can receive messages
// from RingCentral server and from bot users.
//
// In this tutorial, we store the access tokens in a file so that we can reuse it.
// every time we terminate and restart the bot. If the access token is lost, you will
// need to remove and reinstall the bot in order to obtain a new access token.

// In a real production implementation, the acess token should be saved in a more secure
// place and persistent so that it can be reliably re-used if the bot is restarted.
app.get('/oauth', async function (req, res) {
    console.log("Public bot being installed");
    if (!req.query.code){
        res.status(500).send({"Error": "Authorization code is missing."})
        console.log("RingCentral did not send an authorizaton code.");
    } else {
        var creatorId = req.query.creator_extension_id;
        try {
          var params = {
              code : req.query.code,
              redirectUri : OAUTH_REDIRECT_URI
          }
          var resp = await platform.login(params)
          var tokens = await resp.json()
          // Bot access token is almost permanent. Thus, it does not have a refresh token.
          // However, in order to reuse the access token after we stop and restart the bot,
          // we will need to complete the tokens object with a fake refresh token, then save the
          // tokens object to a file, so that we can read and set the saved tokens to the
          // RingCentral JS SDK next time when we restart the bot.
          // See the implementation in the loadSavedTokens() function.
        	tokens['refresh_token'] = 'xxx';
        	tokens['refresh_token_expires_in'] = 10000000000;
          fs.writeFileSync( TOKEN_TEMP_FILE, JSON.stringify( tokens ) )
          res.status(200).send("")
          console.log("Subscribe to Webhooks notification")
  	      subscribeToEvents();
        }catch(e){
          console.error(e.message)
	        res.status(500).send({"Error": "Installing bot and subscribing to events failed."})
        }
    }
});

// Handle authorization for private bots
//
// When a private bot is installed, RingCentral transmits a permanent access token
// to the bot via an HTTP POST.
//
// Then the bot subscribes to webhooks so that it can respond to message
// events.
//
// This server stores that key in memory. As a result, if the server is
// restarted, you will need to remove and reinstall the not in order to obtain
// a fresh API token. In a more advanced implementation, the acess key would
// be persisted so that it can easily be re-used if the server is restarted.
app.post('/oauth', async function (req, res) {
  console.log("Private bot being installed");
    if (req.body.access_token) {
      res.statusCode = 200
      res.send('')
    	// Bot access token is almost permanent. Thus, it does not have a refresh token.
      // For calling RC team messaging API to post messages using the RingCentral JS SDK, we need
      // to create a tokens object and set it to the platform instance.
      // First, we get an empty tokens object from the SDK platform instance, then we assign the
      // access token, the token type and other fake values to satify the SDK's tokens syntax.
      // Finally, we set the tokens object back to the platform instance and also save it to a file
      // for reusage.
    	var data = platform.auth().data();
    	data.access_token = req.body.access_token;
      data.token_type = "bearer"
      data.expires_in = 100000000000;
    	data.refresh_token = 'xxx';
    	data.refresh_token_expires_in = 10000000000;
    	await platform.auth().setData(data);

    	console.log( "Save tokens to a local file for reusage" )
    	fs.writeFileSync( TOKEN_TEMP_FILE, JSON.stringify( data ) )
    	try {
        console.log("Bot installation done")
        subscribeToEvents();
    	} catch(e) {
        console.log(e.message)
    	}
    }else{
      res.statusCode = 401
      res.end()
    }
});

// Callback method received after subscribing to webhook
// This method handles webhook notifications and will be invoked when a user
// types a message to your bot.
app.post('/webhook-callback', function (req, res) {
    var validationToken = req.get('Validation-Token');
    var body = [];
    if (validationToken) {
        console.log('Verifying webhook token.');
        res.setHeader('Validation-Token', validationToken);
    } else if (req.body.event == "/restapi/v1.0/subscription/~?threshold=60&interval=15") {
	     console.log("Renewing subscription ID: " + req.body.subscriptionId);
       renewSubscription(req.body.subscriptionId);
    } else if (req.body.body.eventType == "PostAdded") {
      console.log("Received user's message: " + req.body.body.text);
      if (req.body.ownerId == req.body.body.creatorId) {
        console.log("Ignoring message posted by bot.");
      } else if (req.body.body.text == "ping") {
        send_message( req.body.body.groupId, "pong" )
      } else if (req.body.body.text == "hello") {
        var card = make_hello_world_card(null)
        send_card( req.body.body.groupId, card )
      } else {
        var message = `I do not understand ${req.body.body.text}`
        send_message( req.body.body.groupId, message )
      }
    } else {
      console.log("Event type:", req.body.body.eventType)
      console.log(req.body.body)
    }
    res.statusCode = 200;
    res.end();
});

// This handler is called when a user submit data from an adaptive card
app.post('/user-submit', function (req, res) {
    console.log( "Received card event." )
    var body = req.body
    if (body.data.path == 'new-card'){
      var card = make_new_name_card( body.data.hellotext )
      send_card( body.conversation.id, card)
    }else if (body.data.path == 'update-card'){
      var card = make_hello_world_card( body.data.hellotext )
      update_card( body.card.id, card )
    }
    res.statusCode = 200;
    res.end();
});

// Post a message to a chat
async function send_message( groupId, message ) {
    console.log("Posting response to group: " + groupId);
    try {
      await platform.post(`/restapi/v1.0/glip/chats/${groupId}/posts`, {
  	     "text": message
       })
    }catch(e) {
	    console.log(e)
    }
}

async function send_card( groupId, card ) {
    console.log("Posting a card to group: " + groupId);
    try {
      var resp = await platform.post(`/restapi/v1.0/glip/chats/${groupId}/adaptive-cards`, card)
	  }catch (e) {
	    console.log(e)
	  }
}

async function update_card( cardId, card ) {
    console.log("Updating card...");
    try {
      var resp = await platform.put(`/restapi/v1.0/glip/adaptive-cards/${cardId}`, card)
    }catch (e) {
	    console.log(e.message)
	  }
}

// Method to Subscribe to Team Messaging (a.k.a Glip) Events.
async function subscribeToEvents(token){
    console.log("Subscribing to posts and groups events")
    var requestData = {
        "eventFilters": [
            "/restapi/v1.0/glip/posts",
            "/restapi/v1.0/glip/groups",
            "/restapi/v1.0/subscription/~?threshold=60&interval=15"
        ],
        "deliveryMode": {
            "transportType": "WebHook",
            "address": WEBHOOKS_DELIVERY_ADDRESS
        },
        "expiresIn": 604799
    };
    try {
      var resp = await platform.post('/restapi/v1.0/subscription', requestData)
      var jsonObj = await resp.json()
      console.log('Team Messaging events notifications subscribed successfully.');
      fs.writeFileSync( SUBSCRIPTION_ID_TEMP_FILE, jsonObj.id )
      console.log('Your bot is ready for conversations ...');
    }catch (e) {
      console.error('Team Messaging events notifications subscription failed. ', e);
      throw e;
    }
}

async function renewSubscription(id){
    console.log("Auto subscription renewal");
    try{
      var resp = await platform.post(`/restapi/v1.0/subscription/${id}/renew`)
      var jsonObj = await resp.json()
      console.log("Subscription renewed. Next renewal:" + jsonObj.expirationTime);
    }catch(e) {
	    console.log("Subscription renewal failed: ", e);
      throw e;
    }
}

async function checkWebhooksSubscription() {
  try {
    var subscriptionId = fs.readFileSync(SUBSCRIPTION_ID_TEMP_FILE)
    var resp = await platform.get(`/restapi/v1.0/subscription/${subscriptionId}`)
    var jsonObj = await resp.json()
    if (jsonObj.status == 'Active') {
      console.log("Webhooks subscription is still active.")
      console.log('Your bot is ready for conversations ...');
    }else{
      fs.writeFileSync(SUBSCRIPTION_ID_TEMP_FILE, "")
      console.log("Webhooks subscription status", jsonObj.status)
      console.log("Create new Webhooks subscription")
      subscribeToEvents()
    }
  }catch(e) {
    console.error(e.message);
    throw e;
  }
}


function make_hello_world_card(name) {
    var card = {
    	type: "AdaptiveCard",
    	$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    	version: "1.3",
    	body: [
        {
      		type: "TextBlock",
      		size: "Medium",
      	  weight: "Bolder",
      		text: "Hello World"
        },
        {
      		type: "TextBlock",
      		text: "Enter your name in the field below so that I can say hello.",
      		wrap: true
        },
        {
      		type: "Input.Text",
      		id: "hellotext",
      		placeholder: "Enter your name"
        },
        {
          type: "ActionSet",
          actions: [
            {
              type: "Action.Submit",
              title: "Send a new card",
              data: {
                path: "new-card"
              }
            },
            {
              type: "Action.Submit",
              title: "Update this card",
              data: {
                path: "update-card"
              }
            }
          ]
        }
      ]
    }
    if (name){
      card.body.push({
          type: "Container",
          separator: true,
          items: [
            {
              type: "TextBlock",
            	text: `Hello ${name}`,
            	wrap: true
            }
          ]
        })
    }
    return card
}

function make_new_name_card(name) {
    return {
    	"type": "AdaptiveCard",
    	"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    	"version": "1.3",
    	"body": [
        {
      		"type": "TextBlock",
      		"size": "Medium",
      		"weight": "Bolder",
      		"text": "Hello World"
        },
        {
      		"type": "TextBlock",
      		"text": `Hello ${name}`,
      		"wrap": true
        }
    	]
    }
}
