console.log('Starting server.js: loading required modules...');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

console.log('Required modules loaded successfully');

const app = express();
app.use(bodyParser.json());

// קריאת משתני סביבה מה-CLOUDRUN
const {
  type,
  project_id,
  private_key_id,
  private_key,
  client_email,
  client_id,
  auth_uri,
  token_uri,
  auth_provider_x509_cert_url,
  client_x509_cert_url,
  universe_domain,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PORT = 8080,
  GOOGLE_SHEET_ID,
  GCLOUD_PROJECT,
  WHATSAPP_PHONE,
} = process.env;

console.log('[ENV] Loaded environment variables:', {
  type,
  project_id,
  private_key_id,
  private_key_set: !!private_key,
  client_email,
  client_id,
  auth_uri,
  token_uri,
  auth_provider_x509_cert_url,
  client_x509_cert_url,
  universe_domain,
  VERIFY_TOKEN: VERIFY_TOKEN ? 'set' : 'unset',
  WHATSAPP_TOKEN: WHATSAPP_TOKEN ? 'set' : 'unset',
  PORT,
  GOOGLE_SHEET_ID: GOOGLE_SHEET_ID ? 'set' : 'unset',
  GCLOUD_PROJECT,
  WHATSAPP_PHONE,
});

function validatePrivateKey(key) {
  if (!key) {
    console.error('Private key is missing!');
    return false;
  }
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
    console.error('Private key does not have expected header!');
    return false;
  }
  if (!key.includes('-----END PRIVATE KEY-----')) {
    console.error('Private key does not have expected footer!');
    return false;
  }
  return true;
}

// פונקציה לאישור גישה ל-Google Sheets API עם JWT
async function getAuth() {
  try {
    if (!private_key || !client_email) {
      throw new Error('Missing private_key or client_email in environment variables');
    }
    // החלפת כל "\\n" ל-"\n" במפתח הפרטי ליצירת פורמט תקין
    const cleanedPrivateKey = private_key.replace(/\\n/g, '\n').replace(/\r/g, '').trim();

    if (!validatePrivateKey(cleanedPrivateKey)) {
      throw new Error('Private key format validation failed');
    }

    console.log('cleanedPrivateKey length:', cleanedPrivateKey.length);

    const jwtClient = new google.auth.JWT(
      client_email,
      null,
      cleanedPrivateKey,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );

    await jwtClient.authorize();
    console.log('JWT Client authorized successfully.');
    return jwtClient;
  } catch (err) {
    console.error('[getAuth][ERROR]', err.message || err);
    throw err;
  }
}

async function checkGoogleAuthToken() {
  try {
    const auth = await getAuth();
    console.log('[AuthCheck] Google Auth Token is valid');
    return true;
  } catch (error) {
    console.error('[AuthCheck][ERROR]', error.message);
    return false;
  }
}

// קריאה ראשונית במהלך התחלת השרת לאימות המפתח
checkGoogleAuthToken();

async function getBotFlow() {
  console.log('[BotFlow] Entering getBotFlow()');
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    console.log('[BotFlow] Sheets client created, fetching spreadsheet data...');
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1',
    });
    console.log('[BotFlow] Data fetched from Google Sheet:', res.data.values ? res.data.values.length + ' rows' : 'no data');
    return res.data.values;
  } catch (error) {
    console.error('[BotFlow][ERROR]', error);
    throw error;
  }
}

function parseUserStep(userState, sheetData) {
  console.log(`[Step] Parsing user step for userState: ${userState}`);
  const stages = {};
  if (!sheetData || sheetData.length === 0) {
    console.warn('[Step] Empty or invalid sheetData');
    return null;
  }

  for (let i = 1; i < sheetData.length; i++) {
    const row = sheetData[i];
    if (row && row[0]) {
      stages[row[0]] = row;
    }
  }
  const foundStage = stages[userState];
  console.log(`[Step] Stage found: ${foundStage ? 'yes' : 'no'}`);
  return foundStage || null;
}

app.get('/webhook', (req, res) => {
  console.log('[Webhook][GET] Incoming verification request:', req.query);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook][GET] Verification succeeded');
    return res.status(200).send(challenge);
  } else {
    console.warn('[Webhook][GET] Verification failed');
    return res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body));

  try {
    const sheetData = await getBotFlow();

    let userState = '0';
    const userRow = parseUserStep(userState, sheetData);

    let message = userRow ? `${userRow[1]}\n` : 'שלום, איך אפשר לעזור?';
    if (userRow) {
      if (userRow[2]) message += `1. ${userRow[2]}\n`;
      if (userRow[3]) message += `2. ${userRow[3]}\n`;
    }

    console.log(`[Webhook][POST] Sending reply to ${req.body.from || 'unknown'}:`, message);

    await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
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

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
