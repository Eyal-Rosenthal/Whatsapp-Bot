require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const sheetId = process.env.GOOGLE_SHEET_ID;
const secretClient = new SecretManagerServiceClient();

async function getAuth() {
  const [version] = await secretClient.accessSecretVersion({
    name: 'projects/' + process.env.GCLOUD_PROJECT + '/secrets/keyfile-json/versions/latest',
  });
  const payload = version.payload.data.toString('utf8');
  const key = JSON.parse(payload);

  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function getBotFlow() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1',
  });

  return res.data.values;
}

function parseUserStep(userState, sheetData) {
  const stages = {};
  for (let i = 1; i < sheetData.length; i++) {
    const row = sheetData[i];
    stages[row[0]] = row;
  }
  return stages[userState];
}

app.get('/webhook', (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('GET /webhook received with:', req.query);

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    const sheetData = await getBotFlow();

    // For demo: assume userState '0' (you can extend to track users)
    let userState = '0';
    const userRow = parseUserStep(userState, sheetData);

    let message = userRow ? userRow[1] + '\n' : 'שלום, איך אפשר לעזור?';
    if (userRow && userRow[2]) message += `1. ${userRow[2]}\n`;
    if (userRow && userRow[4]) message += `2. ${userRow[4]}\n`;

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE}/messages`,
      {
        messaging_product: 'whatsapp',
        to: req.body.from, // reply to the sender dynamically
        text: { body: message },
      },
      {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('Error in POST /webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
