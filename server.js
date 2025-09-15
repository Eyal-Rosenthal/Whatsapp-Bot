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
    
    const rowCount = res.data.values ? res.data.values.length : 0;
    console.log('[BotFlow] Data fetched from Google Sheet:', rowCount, 'rows');
    console.log('[BotFlow] Sheet data preview:', JSON.stringify(res.data.values?.slice(0, 3), null, 2));
    
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

// Handle incoming messages with improved state management and logging
const userStates = new Map();

app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] =============START REQUEST=============');
  console.log('[Webhook][POST] Full request body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Extract message details with better error handling
    const from = req.body.from || 'unknown';
    console.log('[Webhook][POST] Processing message from user:', from);
    
    let userInput = '';
    if (req.body.text && req.body.text.body) {
      userInput = req.body.text.body.trim();
    } else if (req.body.message) {
      userInput = req.body.message.trim();
    }
    console.log('[Webhook][POST] User input extracted:', userInput);

    // Get current user state with logging
    let currentStage = userStates.get(from) || '0';
    console.log('[Webhook][POST] Current user stage before processing:', currentStage);
    console.log('[Webhook][POST] UserStates Map contents:', Array.from(userStates.entries()));

    // Fetch sheet data
    console.log('[Webhook][POST] Fetching bot flow data...');
    const sheetData = await getBotFlow();

    // Find current stage row
    let stageRow = sheetData.find(row => row[0] === currentStage);
    if (!stageRow) {
      console.log('[Webhook][POST] Stage not found, defaulting to stage 0');
      currentStage = '0';
      stageRow = sheetData.find(row => row[0] === currentStage);
    }
    console.log('[Webhook][POST] Current stage row:', stageRow);

    // Function to compose message with options
    function composeMessage(row) {
      if (!row || !row[1]) return 'שגיאה בטעינת הודעה';
      
      let msg = row[1] + '\n';
      let optionCount = 1;
      
      // Process options in pairs: option text (col 2,4,6...) + next stage (col 3,5,7...)
      for (let i = 2; i < row.length; i += 2) {
        if (row[i] && row[i].trim()) {
          msg += `${optionCount}. ${row[i]}\n`;
          optionCount++;
        }
      }
      return msg;
    }

    let nextStage = currentStage;
    
    // ניתוח האם זוהי אינטראקציה ראשונה (משתמש חדש או בשלב 0)
    let isNewInteraction = false;
    if (!userStates.has(from) || currentStage === '0') {
      isNewInteraction = true;
    }

    // ניסיון לפרש את הקלט כמספר
    const selectedOption = parseInt(userInput, 10);

    if (isNewInteraction) {
      // משתמש חדש או בשלב 0 - תמיד שולחים תפריט ראשוני ללא מעבר מיידי לשלב הבא
      if (!isNaN(selectedOption) && selectedOption >= 1) {
        console.log('[Webhook][POST] New user or initial state: ignoring immediate selection, sending initial menu');
        userStates.set(from, '0');
        currentStage = '0';

        const stageRow = sheetData.find(row => row[0] === currentStage);
        const responseMessage = composeMessage(stageRow);

        return res.status(200).json({
          message: 'Initial menu sent - please choose an option',
          data: responseMessage,
        });
      }
      // קלט לא תקין או 0 - שולחים את תפריט הפתיחה בלבד
      else {
        console.log('[Webhook][POST] New user or initial state: non-numeric input or zero, sending initial menu');
        userStates.set(from, '0');
        currentStage = '0';

        const stageRow = sheetData.find(row => row[0] === currentStage);
        const responseMessage = composeMessage(stageRow);

        return res.status(200).json({
          message: 'Initial menu sent - please choose an option',
          data: responseMessage,
        });
      }
    } else {
      // משתמש קיים שמבצע בחירה - בודקים אם הבחירה תקינה וחוזרים עם תשובה או שגיאה

      // ספירת אפשרויות תקינות בשלב הנוכחי
      let validOptionsCount = 0;
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i] && stageRow[i].trim()) {
          validOptionsCount++;
        }
      }
      console.log('[Webhook][POST] Valid options count in current stage:', validOptionsCount);

      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        console.log('[Webhook][POST] Processing valid option selection...');
        const nextStageColIndex = 2 * selectedOption + 1;
        console.log('[Webhook][POST] Next stage column index:', nextStageColIndex);

        if (nextStageColIndex < stageRow.length) {
          nextStage = stageRow[nextStageColIndex];
          console.log('[Webhook][POST] Next stage determined:', nextStage);

          // טיפול בשלב סיום (final)
          if (nextStage && nextStage.toLowerCase() === 'final') {
            console.log('[Webhook][POST] Reached final stage, resetting user to initial state');
            userStates.set(from, '0');
            
            const initialStageRow = sheetData.find(row => row[0] === '0');
            const initialMessage = composeMessage(initialStageRow);

            return res.status(200).json({
              message: 'Conversation ended. Returning to initial menu.',
              data: initialMessage,
            });
          }

          // עדכון מצב המשתמש לשלב הבא
          if (nextStage && nextStage !== currentStage) {
            userStates.set(from, nextStage);
            currentStage = nextStage;
            console.log('[Webhook][POST] Updated user state to:', nextStage);
            console.log('[Webhook][POST] UserStates after update:', Array.from(userStates.entries()));
          }
        }
      } else {
        // בחירה לא תקינה - חוזרים עם הודעת שגיאה ותפריט של אותו שלב
        console.log('[Webhook][POST] Invalid option or first time user - sending error message with current menu');
        const errorMsg = `בחרת אפשרות שאינה קיימת (${selectedOption}). אנא בחר מספר בין 1 ל-${validOptionsCount}:\n`;
        const responseMessage = errorMsg + composeMessage(stageRow);

        console.log('[Webhook][POST] Sending error response:', responseMessage);
        return res.status(200).json({
          message: 'Invalid option selected',
          data: responseMessage,
        });
      }
    }

    // בניית ההודעה הסופית ושליחתה
    const finalStageRow = sheetData.find(row => row[0] === currentStage);
    const responseMessage = composeMessage(finalStageRow);

    console.log('[Webhook][POST] Final response message:', responseMessage);
    console.log('[Webhook][POST] Final user state:', currentStage);
    console.log('[Webhook][POST] =============END REQUEST=============');

    return res.status(200).json({
      message: 'Data retrieved successfully',
      data: responseMessage,
    });

  } catch (error) {
    console.error('[Webhook][POST][ERROR] Exception occurred:', error);
    console.error('[Webhook][POST][ERROR] Stack trace:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
