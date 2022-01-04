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
const RINGCENTRAL_CLIENT_ID       = process.env.RINGCENTRAL_CLIENT_ID_PRIVATE;
const RINGCENTRAL_CLIENT_SECRET   = process.env.RINGCENTRAL_CLIENT_SECRET_PRIVATE;
const RINGCENTRAL_SERVER_URL = process.env.RINGCENTRAL_SERVER_URL;
const RINGCENTRAL_OAUTH_REDIRECT_URI = process.env.RINGCENTRAL_OAUTH_REDIRECT_URI
const WEBHOOKS_DELIVERY_ADDRESS = process.env.WEBHOOKS_DELIVERY_ADDRESS

const TOKEN_TEMP_FILE = '.private-bot-auth';
const SUBSCRIPTION_ID_TEMP_FILE = '.private-bot-subscription';

var app = express();

app.use( bp.json() );
app.use( bp.urlencoded({
  extended: true
}));

// Start our server
app.listen(PORT, function () {
    console.log("Bot server listening on port " + PORT);
    // Bot start/restart, check if there is a saved token
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
  redirectUri: RINGCENTRAL_OAUTH_REDIRECT_URI
});

var platform = rcsdk.platform();

async function loadSavedTokens(){
  if (fs.existsSync( TOKEN_TEMP_FILE )) {
    console.log( "Load saved access token")
    var savedTokens = JSON.parse( fs.readFileSync( TOKEN_TEMP_FILE ) );
    console.log( "Reuse saved access token")
    await platform.auth().setData( savedTokens );
    checkWebhooksSubscription()
  }else{
    console.log("Your bot has not been installed or the saved access token was lost!")
    console.log("Login to developers.ringcentral.com, open the bot app and install it by selecting \
the Bot menu and at the 'General Settings' section, click the 'Add to RingCentral' button.")
    console.log("Note: If the bot was installed, remove it and reinstall to get a new access token")
  }
}


// Handle authorization for private bots
//
// When a private bot is installed, RingCentral sends a permanent access token
// to the bot via an HTTP POST request through the specified redirect url. When the bot receives
// the access token, it can use the tokens to post messages to bot users.
//
// In this tutorial, we store the access tokens in a file so that we can reuse it
// every time we terminate and restart the bot.

// If the access token is lost, you will need to remove and reinstall the bot in order
// to obtain a new access token.

// In a real production implementation, the acess token should be saved in a more secure
// place and persistent so that it can be reliably re-used if the bot is restarted.
app.post('/oauth', async function (req, res) {
  console.log("Private bot being installed");
  if (req.body.access_token) {
    res.status(200).send('')
    // Bot access token is almost permanent. Thus, it does not have a refresh token.
    // For calling RC Team Messaging API to post messages using the RingCentral JS SDK, we need
    // to create a token object and set it to the SDK's platform instance.

    // First, we get an empty token object from the SDK's platform instance, then we assign the
    // access token, the token type and other fake values to satify the SDK's tokens syntax.
    var data = platform.auth().data();
    data.access_token = req.body.access_token;
    data.token_type = "bearer"
    data.expires_in = 100000000000;
    data.refresh_token = 'xxx';
    data.refresh_token_expires_in = 10000000000;
    await platform.auth().setData(data);

    // Finally, we set the token object back to the platform instance and also save it to a file
    // for reusage.
    console.log( "Save tokens to a local file for reusage" )
    fs.writeFileSync( TOKEN_TEMP_FILE, JSON.stringify( data ) )
    try {
      console.log("Bot installation done")
      // The bot must subscribe for Team Messaging notifications so that it can receive messages
      // from RingCentral server and from bot users.
      subscribeToEvents();
    } catch(e) {
      console.log(e.message)
    }
  }else{
    res.status(401).end()
  }
});

// Callback method received after subscribing to webhook. This method handles webhook
// notifications and will be invoked when a user sends a message to your bot.
app.post('/webhook-callback', async function (req, res) {
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
    } else if (req.body.body.eventType == 'Delete'){
      console.log('Bot is being uninstalled by a user => clean up resources')
      // Bot is being uninstalled by a user => clean up resouce
      // delete subscription
      await platform.delete(`/restapi/v1.0/subscription/${req.body.subscriptionId}`)
      // clear local database
      fs.unlinkSync(TOKEN_TEMP_FILE)
      fs.unlinkSync(SUBSCRIPTION_ID_TEMP_FILE)
    } else {
      console.log("Event type:", req.body.body.eventType)
      console.log(req.body.body)
    }
    res.status(200).end();
});

// Method to Subscribe for events notification.
async function subscribeToEvents(token){
    console.log("Subscribing to posts and groups events")
    var requestData = {
        eventFilters: [
          "/restapi/v1.0/glip/posts", // Team Messaging (a.k.a Glip) Events.
          "/restapi/v1.0/glip/groups", // Team Messaging (a.k.a Glip) Events.
          "/restapi/v1.0/account/~/extension/~", // Subscribe for this event to detect when a bot is uninstalled
          "/restapi/v1.0/subscription/~?threshold=60&interval=15" // For subscription renewal
        ],
        deliveryMode: {
            transportType: "WebHook",
            address: WEBHOOKS_DELIVERY_ADDRESS
        },
        expiresIn: 604799
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
      fs.unlinkSync(SUBSCRIPTION_ID_TEMP_FILE)
      console.log("Webhooks subscription status", jsonObj.status)
      console.log("Create new Webhooks subscription")
      subscribeToEvents()
    }
  }catch(e) {
    console.error(e.message);
    throw e;
  }
}

// This handler is called when a user submit data from an adaptive card
app.post('/user-submit', function (req, res) {
    console.log( "Received card event." )
    var body = req.body
    console.log(body)
    if (body.data.path == 'new-card'){
      var card = make_new_name_card( body.data.hellotext )
      send_card( body.conversation.id, card)
    }else if (body.data.path == 'update-card'){
      var card = make_hello_world_card( body.data.hellotext )
      update_card( body.card.id, card )
    }
    res.status(200).end();
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

// Send an adaptive card to a chat
async function send_card( groupId, card ) {
    console.log("Posting a card to group: " + groupId);
    try {
      var resp = await platform.post(`/restapi/v1.0/glip/chats/${groupId}/adaptive-cards`, card)
	  }catch (e) {
	    console.log(e)
	  }
}

// Update an adaptive card
async function update_card( cardId, card ) {
    console.log("Updating card...");
    try {
      var resp = await platform.put(`/restapi/v1.0/glip/adaptive-cards/${cardId}`, card)
    }catch (e) {
	    console.log(e.message)
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
