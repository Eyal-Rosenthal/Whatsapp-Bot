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

// פונקציה למציאת שורת מצב גליון לפי סטייט
function getStageRow(stageId) {
  if (!sheetCache || !sheetCache.length) return null;
  return sheetCache.find(row => row[0] === stageId);
}

// פונקציה להצגת הודעת מצב + אפשרויות המספר
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

// בדיקה האם מצב הוא מצב סופי
function isFinalState(row) {
  if (!row) return false;
  // מצב סופי: יש נוסח הודעה ולא קיימות עוד אפשרויות
  for (let i = 2; i < row.length; i++) {
    if (row[i] && row[i].trim()) return false;
  }
  return true;
}

// ניהול סטייטים של המשתמשים
const userStates = new Map();

// Webhook Verification
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

// Handle incoming messages
app.post('/webhook', async (req, res) => {
  try {
    // ודא טעינת cache; אם טרם נטען נסה לטעון
    if (!sheetCache || !sheetCache.length) await loadSheetCacheOnce();

    const from = req.body.from || 'unknown';
    let userInput = '';
    if (req.body.text && req.body.text.body) userInput = req.body.text.body.trim();
    else if (req.body.message) userInput = req.body.message.trim();

    // Stage reset: התחלה/סיום סבב או משתמש חדש => אפס למצב 0
    let currentStage = userStates.get(from);
    if (!currentStage) {
      currentStage = '0';
      userStates.set(from, '0');
      // נכנס תמיד למצב 0 ללא קשר לקלט
      const stageRow = getStageRow('0');
      return res.status(200).json({
        message: 'התחלת שיחה חדשה',
        data: composeMessage(stageRow)
      });
    }

    let stageRow = getStageRow(currentStage);
    if (!stageRow) {
      // בגליון חסר מצב 0, איפוס
      userStates.set(from, '0');
      stageRow = getStageRow('0');
      return res.status(200).json({
        message: 'התחלת שיחה חדשה',
        data: composeMessage(stageRow)
      });
    }

    // בדוק אם זה מצב סופי
    if (isFinalState(stageRow)) {
      // הראה הודעה של מצב סופי, אפס userStates
      userStates.delete(from);
      return res.status(200).json({
        message: 'סיום שיחה',
        data: stageRow[1] || 'תודה!'
      });
    }

    // טיפול בבחירת המשתמש
    // book: רק ספרה תקינה בין האפשרויות, אחרת שגיאה וחזרה
    let validOptionCount = 0;
    for (let i = 2; i < stageRow.length; i += 2) {
      if (stageRow[i] && stageRow[i].trim()) validOptionCount++;
    }

    // הכנת regex לבדוק קלט ספרה תקינה
    const digitRegex = /^[1-9][0-9]*$/;
    if (!userInput || !digitRegex.test(userInput)) {
      // קלט לא תקין: הצג הודעת שגיאה וחזור למצב הנוכחי
      return res.status(200).json({
        message: 'לא הקלדת ספרה מתאימה',
        data: composeMessage(stageRow)
      });
    }

    const selectedOption = parseInt(userInput, 10);
    if (selectedOption < 1 || selectedOption > validOptionCount) {
      // קלט מספרי לא באינטרוול האפשרויות
      return res.status(200).json({
        message: 'לא הקלדת ספרה מתאימה',
        data: composeMessage(stageRow)
      });
    }

    // מעבר למצב הבא מהגיליון (חלוקה ל-indices)
    const nextStageColIndex = 2 * selectedOption + 1;
    const nextStageId = stageRow[nextStageColIndex];

    // אין סטייט המשך -- שגיאה וחזור
    if (!nextStageId || !getStageRow(nextStageId)) {
      return res.status(200).json({
        message: 'לא הקלדת ספרה מתאימה',
        data: composeMessage(stageRow)
      });
    }

    // בדוק אם המצב הבא הוא סופי
    const nextStageRow = getStageRow(nextStageId);

    if (isFinalState(nextStageRow)) {
      userStates.delete(from);
      return res.status(200).json({
        message: 'סיום שיחה',
        data: nextStageRow[1] || 'תודה!'
      });
    }

    // מעבר אמיתי לשלב הבא והצגת הודעה + אופציות
    userStates.set(from, nextStageId);
    return res.status(200).json({
      message: 'הודעת מצב חדשה',
      data: composeMessage(nextStageRow)
    });

  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
