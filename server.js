console.log('Starting server.js: loading required modules...');

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');


const bodyParser = require('body-parser');

console.log('Required modules loaded successfully');

const type = process.env.type;
const project_id = process.env.project_id;
const private_key_id = process.env.private_key_id;
const private_key = process.env.private_key;
const client_email = process.env.client_email;
const client_id = process.env.client_id;
const auth_uri = process.env.auth_uri;
const token_uri = process.env.token_uri;
const auth_provider_x509_cert_url = process.env.auth_provider_x509_cert_url;
const client_x509_cert_url = process.env.client_x509_cert_url;
const universe_domain = process.env.universe_domain;


const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PORT = process.env.PORT || 8080;
const sheetId = process.env.GOOGLE_SHEET_ID;
const projectId = process.env.GCLOUD_PROJECT;
const whatsappPhone = process.env.WHATSAPP_PHONE;

console.log(`[ENV] VERIFY_TOKEN: ${VERIFY_TOKEN ? 'set' : 'unset'}, WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'set' : 'unset'}, PORT: ${PORT}, GOOGLE_SHEET_ID: ${sheetId ? 'set' : 'unset'}, GCLOUD_PROJECT: ${projectId ? projectId : 'unset'}, WHATSAPP_PHONE: ${whatsappPhone ? 'set' : 'unset'}`);


async function getBotFlow() {
  console.log('[BotFlow] Entering getBotFlow()');
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    console.log('[BotFlow] Sheets client created, fetching spreadsheet data...');
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1',
    });
    console.log('[BotFlow] Data fetched from Google Sheet');
    return res.data.values;
  } catch (error) {
    console.error('[BotFlow][ERROR]', error);
    throw error;
  }
}

function parseUserStep(userState, sheetData) {
  console.log(`[Step] Parsing user step: ${userState}`);
  const stages = {};
  for (let i = 1; i < sheetData.length; i++) {
    const row = sheetData[i];
    stages[row] = row;
  }
  console.log(`[Step] Stage found: ${stages[userState] ? 'yes' : 'no'}`);
  return stages[userState];
}

app.get('/webhook', (req, res) => {
  console.log('[Webhook][GET] Query:', req.query);
  const verifyToken = VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook][GET] Verification succeeded');
    res.status(200).send(challenge);
  } else {
    console.warn('[Webhook][GET] Verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Body:', JSON.stringify(req.body));
  try {
    const sheetData = await getBotFlow();
    // For demo: always at '0'. Extend logic for user state as needed.
    let userState = '0';
    const userRow = parseUserStep(userState, sheetData);
    let message = userRow ? userRow[1] + '\n' : 'שלום, איך אפשר לעזור?';
    if (userRow && userRow) message += `1. ${userRow}\n`;
    if (userRow && userRow) message += `2. ${userRow}\n`;
    console.log(`[Webhook][POST] Replying to ${req.body.from} with message: ${message}`);
    await axios.post(
      `https://graph.facebook.com/v18.0/${whatsappPhone}/messages`,
      {
        messaging_product: 'whatsapp',
        to: req.body.from,
        text: { body: message },
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      }
    );
    console.log('[Webhook][POST] Message sent successfully');
    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook][POST][ERROR]', err);
    res.status(500).send('Internal Server Error');
  }
});

console.log('[Server] Environment variables:', {
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  VERIFY_TOKEN: VERIFY_TOKEN ? 'set' : 'unset',
  WHATSAPP_TOKEN: WHATSAPP_TOKEN ? 'set' : 'unset',
  GOOGLE_SHEET_ID: sheetId ? 'set' : 'unset',
  WHATSAPP_PHONE: whatsappPhone ? 'set' : 'unset',
  PORT,
});

app.listen(PORT, () => {
  console.log(`[Server] Server listening on port ${PORT}`);
});
