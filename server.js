console.log('Starting server.js: loading required modules.');

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
  WHATSAPP_TOKEN,
  PORT = 8080,
  GOOGLE_SHEET_ID,
  GCLOUD_PROJECT,
  WHATSAPP_PHONE,
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

let sheetDataCached = null;

async function loadBotFlowCache() {
  try {
    console.log('[BotFlow] Loading and caching bot flow data.');
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1',
    });
    sheetDataCached = res.data.values || [];
    console.log(`[BotFlow] Cached ${sheetDataCached.length} rows from Google Sheet`);
  } catch (error) {
    console.error('[BotFlow][ERROR] Loading bot flow cache failed:', error);
    sheetDataCached = null;
  }
}

loadBotFlowCache();

function composeMessage(row) {
  if (!row || !row[1]) return 'שגיאה בטעינת הודעה';
  let msg = row[1] + '\n';
  let optionCount = 1;
  for (let i = 2; i < row.length; i += 2) {
    if (row[i] && row[i].trim()) {
      msg += `${optionCount}. ${row[i]}\n`;
      optionCount++;
    }
  }
  return msg;
}

// מצב לכל משתמש
const userStates = new Map();   // from -> 'stageId'
const userFlags  = new Map();   // from -> { justReset: boolean }

// אימות webhook
app.get('/webhook', (req, res) => {
  console.log('[Webhook][GET] Verification request:', req.query);
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
  console.log('[Webhook][POST] =============START REQUEST=============');
  console.log('[Webhook][POST] Full request body:', JSON.stringify(req.body, null, 2));

  try {
    if (!sheetDataCached) {
      console.warn('[Webhook][POST] No cached sheet data available');
      await loadBotFlowCache();
      if (!sheetDataCached) {
        return res.status(500).json({ error: 'Failed to load bot flow data' });
      }
    }

    const from = req.body.from || 'unknown';
    console.log('[Webhook][POST] User:', from);

    let userInput = '';
    if (req.body.text && req.body.text.body) {
      userInput = req.body.text.body.trim();
    } else if (req.body.message) {
      userInput = req.body.message.trim();
    }
    userInput = (userInput || '').toLowerCase();
    console.log('[Webhook][POST] User input:', userInput);

    // אתחול משתמש חדש: תמיד מצב "0" והתעלמות מהודעה ראשונה (גם אם מספר)
    if (!userStates.has(from)) {
      userStates.set(from, '0');
      userFlags.set(from, { justReset: true });
    }

    let currentStage = userStates.get(from);
    let flags = userFlags.get(from) || { justReset: false };
    console.log('[Webhook][POST] Current stage:', currentStage, 'Flags:', flags);

    // איתור שורת המצב
    let stageRow = sheetDataCached.find(row => row[0] === currentStage);
    if (!stageRow) {
      currentStage = '0';
      userStates.set(from, currentStage);
      flags.justReset = true; // אין שורה למצב? חזרה ל-0 כמו התחלה
      userFlags.set(from, flags);
      stageRow = sheetDataCached.find(row => row[0] === currentStage);
    }
    console.log('[Webhook][POST] Stage row found:', !!stageRow);

    // כמה אופציות קיימות בשורה (טקסטים ב-2,4,6... ויעדי-מצב ב-3,5,7...)
    const countOptions = () => {
      let count = 0;
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i] && stageRow[i].trim()) count++;
      }
      return count;
    };
    const validOptionsCount = countOptions();

    const selectedOption = parseInt(userInput, 10);
    const isNumeric = !isNaN(selectedOption);

    // ===== לוגיקת מצב 0 =====
    if (currentStage === '0') {
      // ההודעה הראשונה אחרי התחלה/איפוס: הצג תפריט והתעלם מקלט
      if (flags.justReset) {
        flags.justReset = false;
        userFlags.set(from, flags);
        const responseMessage = composeMessage(stageRow);
        console.log('[Webhook][POST] Initial/reset message -> show menu only');
        return res.status(200).json({
          message: 'שלום! אנא בחר אפשרות מהתפריט להמשך.',
          data: responseMessage,
        });
      }

      // לאחר שכבר הצגנו את תפריט 0, ניתן להתקדם לפי בחירה תקפה
      if (isNumeric && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        const nextStageColIndex = 2 * selectedOption + 1; // 1→3, 2→5 ...
        const nextStage = stageRow[nextStageColIndex];

        // אם הבחירה אינה מובילה לשלב, חזרה ל-0
        if (!nextStage || !String(nextStage).trim()) {
          userStates.set(from, '0');
          userFlags.set(from, { justReset: true });
          const initialStageRow = sheetDataCached.find(row => row[0] === '0');
          const initialMessage = composeMessage(initialStageRow);
          console.log('[Webhook][POST] Option at stage 0 had no next stage -> reset to 0');
          return res.status(200).json({
            message: 'הגעת לסיום השיחה. חוזר לתפריט הראשי.',
            data: initialMessage,
          });
        }

        // עדכון למצב הבא
        userStates.set(from, String(nextStage));
        currentStage = String(nextStage);
        stageRow = sheetDataCached.find(row => row[0] === currentStage);

        const responseMessage = composeMessage(stageRow);
        console.log('[Webhook][POST] Advanced from stage 0 to:', currentStage);
        return res.status(200).json({
          message: 'מעבר לשלב הבא בוצע.',
          data: responseMessage,
        });
      }

      // קלט לא תקף במצב 0 (אחרי שהוצג תפריט): הצג תפריט + שגיאה
      const responseMessage = `בחרת אפשרות לא תקינה${isNumeric ? ` (${userInput})` : ''}. אנא בחר מספר תקף מהתפריט:\n` + composeMessage(stageRow);
      console.log('[Webhook][POST] Invalid choice at stage 0 -> show menu again');
      return res.status(200).json({
        message: 'בחירה לא תקינה',
        data: responseMessage,
      });
    }

    // ===== לוגיקת מעבר במצבים שאינם 0 =====
    if (isNumeric && selectedOption >= 1 && selectedOption <= validOptionsCount) {
      const nextStageColIndex = 2 * selectedOption + 1;
      const nextStage = stageRow[nextStageColIndex];
      console.log('[Webhook][POST] Next stage candidate:', nextStage);

      // הגעה לסוף/FINAL → חזרה ל-0
      if (nextStage && String(nextStage).toLowerCase() === 'final') {
        userStates.set(from, '0');
        userFlags.set(from, { justReset: true });
        const initialStageRow = sheetDataCached.find(row => row[0] === '0');
        const initialMessage = composeMessage(initialStageRow);
        console.log('[Webhook][POST] Final stage reached -> reset to 0');
        return res.status(200).json({
          message: 'הגעת לסיום השיחה. חוזר לתפריט הראשי.',
          data: initialMessage,
        });
      }

      // אם אין יעד-מצב מוגדר או שהוא ריק → נחשב סיום ונאפס
      if (!nextStage || !String(nextStage).trim()) {
        userStates.set(from, '0');
        userFlags.set(from, { justReset: true });
        const initialStageRow = sheetDataCached.find(row => row[0] === '0');
        const initialMessage = composeMessage(initialStageRow);
        console.log('[Webhook][POST] No next stage (implicit final) -> reset to 0');
        return res.status(200).json({
          message: 'הגעת לסיום השיחה. חוזר לתפריט הראשי.',
          data: initialMessage,
        });
      }

      // מעבר תקין
      userStates.set(from, String(nextStage));
      currentStage = String(nextStage);
      stageRow = sheetDataCached.find(row => row[0] === currentStage);
      console.log('[Webhook][POST] Updated user state to:', currentStage);
    } else {
      // בחירה לא תקינה
      const errorMsg = `בחרת אפשרות לא תקינה${userInput ? ` (${userInput})` : ''}. אנא בחר מספר תקף מהתפריט:\n`;
      const responseMessage = errorMsg + composeMessage(stageRow);
      console.log('[Webhook][POST] Sending error response with current menu');
      return res.status(200).json({
        message: 'בחירה לא תקינה',
        data: responseMessage,
      });
    }

    // שליחת התוכן של המצב הנוכחי לאחר עדכון (או ללא שינוי אם לא היה מעבר)
    const responseMessage = composeMessage(stageRow);
    console.log('[Webhook][POST] Sending response for stage:', currentStage);
    console.log('[Webhook][POST] =============END REQUEST=============');

    return res.status(200).json({
      message: 'נתונים נטענו בהצלחה',
      data: responseMessage,
    });

  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error);
    return res.status(500).json({
      error: 'שגיאה פנימית בשרת',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
