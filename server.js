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

// Cache של נתוני הגיליון בזיכרון
let sheetDataCached = null;

// קריאת נתונים מ-Google Sheets - רושמים ל-cache
async function loadBotFlowCache() {
  try {
    console.log('[BotFlow] Loading and caching bot flow data...');
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

// טען את הנתונים בשרת בזמן הריצה הראשונית
loadBotFlowCache();

// פונקציה להרכבת הודעה עם אפשרויות מתוך שורת מצב
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

// מפת זיכרון למצבים
const userStates = new Map();

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

    console.log('[Webhook][POST] User input:', userInput);

    let currentStage = userStates.get(from) || '0';
    console.log('[Webhook][POST] Current stage:', currentStage);

    let stageRow = sheetDataCached.find(row => row[0] === currentStage);
    if (!stageRow) {
      currentStage = '0';
      stageRow = sheetDataCached.find(row => row[0] === currentStage);
    }
    console.log('[Webhook][POST] Stage row found:', !!stageRow);

    const selectedOption = parseInt(userInput, 10);

    if (!userStates.has(from) || currentStage === '0') {
      // משתמש חדש או שלב 0

      // אם המספר תקף, נסה לעבור לשלב לפי הבחירה במקום להתעלם
      let validOptionsCount = 0;
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i] && stageRow[i].trim()) validOptionsCount++;
      }

      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        // חישוב העמודה של השלב הבא
        const nextStageColIndex = 2 * selectedOption + 1;
        const nextStage = stageRow[nextStageColIndex];
        console.log('[Webhook][POST] Next stage for new user/stage 0:', nextStage);

        if (nextStage && nextStage.toLowerCase() === 'final') {
          // סוף השיחה - איפוס למצב 0
          userStates.set(from, '0');
          const initialStageRow = sheetDataCached.find(row => row[0] === '0');
          const initialMessage = composeMessage(initialStageRow);
          return res.status(200).json({
            message: 'Conversation ended. Returning to initial menu.',
            data: initialMessage,
          });
        }

        if (nextStage) {
          userStates.set(from, nextStage);
          currentStage = nextStage;
          stageRow = sheetDataCached.find(row => row[0] === currentStage);
        }

        const responseMessage = composeMessage(stageRow);
        console.log('[Webhook][POST] Sending response for updated stage:', currentStage);
        return res.status(200).json({
          message: 'Data retrieved successfully',
          data: responseMessage,
        });

      } else {
        // קלט לא חוקי - הצג תפריט התחלה עם הודעת שגיאה אם המספר לא תקף
        userStates.set(from, '0');
        currentStage = '0';
        const initialStageRow = sheetDataCached.find(row => row[0] === '0');
        const errorMsg = (!isNaN(selectedOption) && selectedOption >= 1)
          ? ''
          : 'נא לבחור מספר תקף מתוך האפשרויות:\n';
        const responseMessage = errorMsg + composeMessage(initialStageRow);
        return res.status(200).json({
          message: 'Initial menu sent - please choose an option',
          data: responseMessage,
        });
      }
    } else {
      // משתמש קיים בשלבים אחרי 0
      let validOptionsCount = 0;
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i] && stageRow[i].trim()) validOptionsCount++;
      }
      console.log('[Webhook][POST] Valid options count:', validOptionsCount);

      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        const nextStageColIndex = 2 * selectedOption + 1;
        const nextStage = stageRow[nextStageColIndex];
        console.log('[Webhook][POST] Next stage:', nextStage);

        if (nextStage && nextStage.toLowerCase() === 'final') {
          console.log('[Webhook][POST] Reached final stage, resetting user to initial state');
          userStates.set(from, '0');
          const initialStageRow = sheetDataCached.find(row => row[0] === '0');
          const initialMessage = composeMessage(initialStageRow);
          return res.status(200).json({
            message: 'Conversation ended. Returning to initial menu.',
            data: initialMessage,
          });
        }

        if (nextStage && nextStage !== currentStage) {
          userStates.set(from, nextStage);
          currentStage = nextStage;
          stageRow = sheetDataCached.find(row => row[0] === currentStage);
          console.log('[Webhook][POST] Updated user state to:', currentStage);
        }
      } else {
        // בחירה לא תקינה
        const errorMsg = `בחרת אפשרות שאינה קיימת (${selectedOption}). אנא בחר מספר בין 1 ל-${validOptionsCount}:\n`;
        const responseMessage = errorMsg + composeMessage(stageRow);
        console.log('[Webhook][POST] Sending error response with current menu');
        return res.status(200).json({
          message: 'Invalid option selected',
          data: responseMessage,
        });
      }
    }

    const responseMessage = composeMessage(stageRow);
    console.log('[Webhook][POST] Sending response for stage:', currentStage);
    console.log('[Webhook][POST] =============END REQUEST=============');

    return res.status(200).json({
      message: 'Data retrieved successfully',
      data: responseMessage,
    });

  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
