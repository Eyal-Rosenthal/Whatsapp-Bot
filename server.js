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
  WHATSAPP_TOKEN, // Meta API token
  PORT = 8080,
  GOOGLE_SHEET_ID,
  GCLOUD_PROJECT,
  WHATSAPP_PHONE, // Phone Number ID, not the actual number
} = process.env;

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

// טעינת cache של הגליון פעם אחת בלבד עם העלאת השרת
let sheetCache = null;
async function loadSheetCacheOnce() {
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    console.log('[BotFlow] Loading sheet data from Google Sheets...');
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1',
    });
    sheetCache = res.data.values;
    console.log('[BotFlow] Sheet data cached:', sheetCache.length, 'rows');
  } catch (err) {
    console.error('[BotFlow][ERROR] Failed to load Google Sheet:', err.message);
    sheetCache = [];
  }
}
loadSheetCacheOnce();

function getStageRow(stageId) {
  if (!sheetCache || !sheetCache.length) return null;
  return sheetCache.find(row => row[0] === stageId);
}
function composeMessage(row) {
  if (!row || !row[1]) return 'שגיאה - לא נמצא נוסח להודעה';
  let msg = row[1] + "\n";
  let optionNum = 1;
  for (let i = 2; i < row.length; i += 2) {
    if (row[i] && row[i].trim()) {
      msg += `${optionNum}. ${row[i]}\n`;
      optionNum++;
    }
  }
  return msg.trim();
}
function isFinalState(row) {
  if (!row) return false;
  for (let i = 2; i < row.length; i++) {
    if (row[i] && row[i].trim()) return false;
  }
  return true;
}
const userStates = new Map();

// Verify webhook for WhatsApp API
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

// שליחת הודעה ללקוח דרך WhatsApp Cloud API
async function sendWhatsappReply(to, text) {
  try {
    const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`;
    await axios.post(url,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: text }
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );
    console.log(`[WhatsApp] Sent message to ${to}: ${text}`);
  } catch (err) {
    console.error(`[WhatsApp] Error sending to ${to}:`, err.response?.data || err.message);
  }
}

// עיבוד הודעות נכנסות בפורמט של WhatsApp API
app.post('/webhook', async (req, res) => {
  // לוג מפורט של גוף הבקשה
  console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body, null, 2));
  try {
    if (!sheetCache || !sheetCache.length) await loadSheetCacheOnce();

    let from = null, userInput = '';
    if (req.body.entry && Array.isArray(req.body.entry)) {
      // Webhook של WhatsApp
      try {
        const msgObj = req.body.entry[0]?.changes[0]?.value?.messages?.[0];
        from = msgObj?.from;
        userInput = msgObj?.text?.body?.trim() || '';
      } catch (e) { from = null; userInput = ''; }
    }
    // סימולציה או POSTMAN
    if (!from) from = req.body.from || 'unknown';
    if (!userInput) {
      if (req.body.text && req.body.text.body) userInput = req.body.text.body.trim();
      else if (req.body.message) userInput = req.body.message.trim();
    }

    let currentStage = userStates.get(from);
    if (!currentStage) {
      currentStage = '0';
      userStates.set(from, '0');
      const stageRow = getStageRow('0');
      await sendWhatsappReply(from, composeMessage(stageRow));
      return res.sendStatus(200);
    }
    let stageRow = getStageRow(currentStage);
    if (!stageRow) {
      userStates.set(from, '0');
      stageRow = getStageRow('0');
      await sendWhatsappReply(from, composeMessage(stageRow));
      return res.sendStatus(200);
    }
    if (isFinalState(stageRow)) {
      userStates.delete(from);
      await sendWhatsappReply(from, stageRow[1] || 'תודה!');
      return res.sendStatus(200);
    }
    // בדיקת קלט - רק ספרה חוקית
    let validOptionCount = 0;
    for (let i = 2; i < stageRow.length; i += 2) {
      if (stageRow[i] && stageRow[i].trim()) validOptionCount++;
    }
    const digitRegex = /^[1-9][0-9]*$/;
    if (!userInput || !digitRegex.test(userInput)) {
      await sendWhatsappReply(from, 'לא הקלדת ספרה מתאימה\n' + composeMessage(stageRow));
      return res.sendStatus(200);
    }
    const selectedOption = parseInt(userInput, 10);
    if (selectedOption < 1 || selectedOption > validOptionCount) {
      await sendWhatsappReply(from, 'לא הקלדת ספרה מתאימה\n' + composeMessage(stageRow));
      return res.sendStatus(200);
    }
    // מעבר למצב הבא
    const nextStageColIndex = 2 * selectedOption + 1;
    const nextStageId = stageRow[nextStageColIndex];
    if (!nextStageId || !getStageRow(nextStageId)) {
      await sendWhatsappReply(from, 'לא הקלדת ספרה מתאימה\n' + composeMessage(stageRow));
      return res.sendStatus(200);
    }
    const nextStageRow = getStageRow(nextStageId);
    if (isFinalState(nextStageRow)) {
      userStates.delete(from);
      await sendWhatsappReply(from, nextStageRow[1] || 'תודה!');
      return res.sendStatus(200);
    }
    userStates.set(from, nextStageId);
    await sendWhatsappReply(from, composeMessage(nextStageRow));
    return res.sendStatus(200);

  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
