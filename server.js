console.log('Starting server.js: loading required modules...');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
console.log('Required modules loaded successfully');
const app = express();
app.use(bodyParser.json());

// משתני סביבה לניהול קובץ credentials
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
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PORT = 8080,
  GOOGLE_SHEET_ID,
  GCLOUD_PROJECT,
  WHATSAPP_PHONE,
} = process.env;

// יצירת קובץ credentials.json בזמן ריצה
const credentials = {
  type,
  project_id,
  private_key_id,
  private_key: private_key ? private_key.replace(/\\n/g, '\n') : undefined,
  client_email,
  client_id,
  auth_uri,
  token_uri,
  auth_provider_x509_cert_url,
  client_x509_cert_url,
};
const keyFilePath = path.join(__dirname, 'credentials.json');
fs.writeFileSync(keyFilePath, JSON.stringify(credentials));
console.log('[ENV] credentials.json file created at', keyFilePath);

// פונקציה לקבלת Google Auth מתוך הקובץ
async function getAuth() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const jwtClient = await auth.getClient();
    console.log('JWT Client authorized successfully.');
    return jwtClient;
  } catch (err) {
    console.error('[getAuth][ERROR]', err.message || err);
    throw err;
  }
}

// בדיקה ראשונית של המפתח בעת הרצת השרת
(async () => {
  try {
    const auth = await getAuth();
    console.log('[AuthCheck] Google Auth Token is valid');
  } catch (error) {
    console.error('[AuthCheck][ERROR]', error.message);
  }
})();

// קריאת נתונים מ-Google Sheets
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


const userStates = new Map(); // In-memory user state store, keyed by user phone or ID

app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body));

  try {
    const from = req.body.from || 'unknown';
    let userInput = '';

    // Extract user's message text (adjust depending on your payload structure)
    if (req.body.text && req.body.text.body) userInput = req.body.text.body.trim();
    else if (req.body.message) userInput = req.body.message.trim();

    // Get user's current state or initialize to '0' if new user
    let userState = userStates.get(from) || '0';

    const sheetData = await getBotFlow();

    // If userState is '0', userInput is general message or number to start flow, else treat as step input
    if (userState === '0') {
      // maybe validate input here and assign next step accordingly; example just proceed
      // For start, keep state '0' to get first row
    } else {
      // update userState to userInput assuming it's a valid step number matching a row index
      userState = userInput;
    }

    // Store updated state for user
    userStates.set(from, userState);

    // Parse user step row from data
    const userRow = parseUserStep(userState, sheetData);

    // Compose message: title from column 1, then numbered options from remaining columns
    let message = userRow ? `${userRow[1]}\n` : 'שלום, איך אפשר לעזור?';

    if (userRow) {
      for (let i = 2; i < userRow.length; i++) {
        if (userRow[i]) message += `${i - 1}. ${userRow[i]}\n`;
      }
    }

    console.log(`[Webhook][POST] Sending reply to ${from}:`, message);

    res.status(200).json({
      message: 'Data retrieved successfully',
      data: message
    });

  } catch (error) {
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// app.post('/webhook', async (req, res) => {
//   console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body));
//   try {
//     const sheetData = await getBotFlow();
//     let userState = '0';
//     const userRow = parseUserStep(userState, sheetData);
//     //let message = userRow ? `${userRow[1]}\\n` : 'שלום, איך אפשר לעזור?';
//     //if (userRow) {
//     //  if (userRow[2]) message += `1. ${userRow[2]}\\n`;
//     //  if (userRow[3]) message += `2. ${userRow[3]}\\n`;
//     //}

//     let message = userRow ? `${userRow[1]}\n` : 'שלום, איך אפשר לעזור?';
// if (userRow) {
//   if (userRow[2]) message += `1. ${userRow[2]}\n`;
//   if (userRow[3]) message += `2. ${userRow[3]}\n`;
// }


//     console.log(`[Webhook][POST] Sending reply to ${req.body.from || 'unknown'}:`, message);
//     //await axios.post(
//     //  `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
//     //  {
//     //    messaging_product: 'whatsapp',
//     //    to: req.body.from,
//     //    text: { body: message },
//     //  },
//     //  {
//     //    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
//     //  }
//     //);


//     //simulating response for postman testing

//     // app.post('/your-endpoint', async (req, res) => {
//     //try {
//     // Extract relevant data from the request body
//     //const userRequest = req.body;  // adjust this as needed

//     // Retrieve data from Google Sheets based on userRequest
//     //const relevantData = await getGoogleSheetData(userRequest); // Your existing function

//     // Instead of sending message via WhatsApp API, directly send JSON response
//     res.status(200).json({
//       message: 'Data retrieved successfully',
//       data: message,
//     });
//   } catch (error) {
//     res.status(500).json({ error: 'Internal server error', details: error.message });
//   }
// });

//end of simulating response for postman testing

  //  console.log('[Webhook][POST] Message sent successfully');
  //  res.sendStatus(200);
  //} catch (err) {
  //  console.error('[Webhook][POST][ERROR]', err);
  //  res.status(500).send('Internal Server Error');
  //}
//});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
