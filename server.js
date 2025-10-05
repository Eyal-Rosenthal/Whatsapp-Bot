console.log('=== SERVER.JS LOADING: VERSION OCT 5 ===');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();

app.use(express.json());

const {
  type, project_id, private_key_id, private_key, client_email, client_id,
  auth_uri, token_uri, auth_provider_x509_cert_url, client_x509_cert_url,
  VERIFY_TOKEN, WHATSAPP_TOKEN, PORT = 8080, GOOGLE_SHEET_ID, WHATSAPP_PHONE
} = process.env;

// שלב יצירת credentials
const credentials = {
  type, project_id, private_key_id,
  private_key: private_key ? private_key.replace(/\\n/g, '\n') : undefined,
  client_email, client_id, auth_uri, token_uri,
  auth_provider_x509_cert_url, client_x509_cert_url
};
const keyFilePath = path.join(__dirname, 'credentials.json');

try {
  fs.writeFileSync(keyFilePath, JSON.stringify(credentials));
  console.log('[Startup] credentials.json written:', keyFilePath);
} catch (e) {
  console.error('[Startup][ERROR] Cannot write credentials:', e.message);
}

async function getAuth() {
  console.log('[Google] Authorizing JWT...');
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const jwtClient = await auth.getClient();
    console.log('[Google] JWT authorized');
    return jwtClient;
  } catch (err) {
    console.error('[Google][ERROR]', err.message);
    throw err;
  }
}

async function getBotFlow() {
  console.log('[BotFlow] Loading Google Sheet');
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1',
    });
    console.log(`[BotFlow] Sheet has ${res.data.values.length} rows`);
    return res.data.values;
  } catch (err) {
    console.error('[BotFlow][ERROR]', err.message);
    throw err;
  }
}

const userStates = new Map();

app.get('/webhook', (req, res) => {
  console.log('[Webhook][GET] VERIFY:', req.query);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook][GET] Verification success');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook][GET] Verification failed');
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  console.log('=== POST /webhook: ENTERED HANDLER ===');
  res.sendStatus(200);
});

  try {
    console.log('[Webhook][POST] BODY:', JSON.stringify(req.body));
    let from = null, userInput = '';

    // שלב ניתוח מבנה הודעה
    if (req.body.entry && req.body.entry.length > 0) {
      try {
        const entry = req.body.entry[0];
        if (entry.changes && entry.changes.length > 0) {
          const msg = entry.changes[0].value.messages?.[0];
          if (msg) {
            from = msg.from;
            userInput = msg.text?.body?.trim() || '';
          }
        }
      } catch (e) {
        console.error('[Webhook][POST][ERROR] Entry parse:', e.message);
      }
    }
    if (!from) {
      console.error('[Webhook][POST] Cannot extract sender info!', JSON.stringify(req.body));
      return res.sendStatus(400);
    }
    console.log(`[Webhook][POST] FROM: ${from}, MSG: "${userInput}"`);

    // שלב קריאת הבוט
    let sheetData;
    try {
      sheetData = await getBotFlow();
      console.log('[Webhook][POST] Sheet loaded');
    } catch (e) {
      console.error('[Webhook][POST][ERROR] Load sheet:', e.message);
      return res.sendStatus(500);
    }

    // סטייט
    let currentStage = userStates.get(from) || '0';
    let stageRow = sheetData.find(row => row[0] === currentStage);
    if (!stageRow) {
      currentStage = '0';
      stageRow = sheetData.find(row => row[0] === currentStage);
    }
    function composeMessage(row) {
      let msg = row[1] + '\n';
      for (let i = 2, optionCount = 1; i < row.length; i += 2, optionCount++)
        if (row[i]) msg += `${optionCount}. ${row[i]}\n`;
      return msg.trim();
    }

    // לוגיקה עם לוגים מפורטים
    if (userInput && currentStage !== '0') {
      console.log(`[Webhook][POST] User input: ${userInput}; Current stage: ${currentStage}`);
      const selectedOption = parseInt(userInput, 10);
      const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        const nextStageColIndex = 2 * selectedOption + 1;
        const nextStage = stageRow[nextStageColIndex];
        console.log(`[Webhook][POST] Option OK; Next: ${nextStage}`);
        if (nextStage?.toLowerCase() === 'final') {
          userStates.delete(from);
          const finalMsg = 'תודה שיצרת קשר!';
          console.log(`[Webhook][POST] END for ${from}: ${finalMsg}`);
          await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            { messaging_product: 'whatsapp', to: from, text: { body: finalMsg }},
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
          );
          return res.sendStatus(200);
        } else if (nextStage) {
          userStates.set(from, nextStage);
          stageRow = sheetData.find(row => row[0] === nextStage);
        } else {
          const msg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
          console.log('[Webhook][POST] Invalid menu option, sending error to user');
          await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            { messaging_product: 'whatsapp', to: from, text: { body: msg }},
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
          );
          return res.sendStatus(200);
        }
      } else {
        const msg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
        console.log('[Webhook][POST] Invalid input (not a number), sending error');
        await axios.post(
          `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
          { messaging_product: 'whatsapp', to: from, text: { body: msg }},
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        return res.sendStatus(200);
      }
    } else if (currentStage === '0') {
      userStates.set(from, currentStage);
      console.log('[Webhook][POST] Set initial stage');
    }

    // תשובת בסיס
    const responseMessage = composeMessage(stageRow);
    console.log(`[Webhook][POST] REPLY to ${from}:\n${responseMessage}`);

    await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
      { messaging_product: 'whatsapp', to: from, text: { body: responseMessage }},
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    console.log('[Webhook][POST] Message sent!');

    return res.sendStatus(200);

  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error.message, error);
    if (error.response) console.error('[Webhook][POST][API ERR]', error.response.data);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

process.on('unhandledRejection', err => console.error('[UNHANDLED]', err));
process.on('uncaughtException', err => console.error('[EXCEPTION]', err));
