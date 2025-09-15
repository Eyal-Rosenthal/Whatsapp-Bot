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

    // Check if user input is a valid option selection
    if (userInput) {
      const selectedOption = parseInt(userInput, 10);
      console.log('[Webhook][POST] Parsed user input as number:', selectedOption);
      
      // Count valid options in current stage
      let validOptionsCount = 0;
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i] && stageRow[i].trim()) {
          validOptionsCount++;
        }
      }
      console.log('[Webhook][POST] Valid options count in current stage:', validOptionsCount);

      // Check if input is a valid option number
      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        console.log('[Webhook][POST] Processing valid option selection...');
        
        // Calculate next stage column index: options at 2,4,6... next stages at 3,5,7...
        const nextStageColIndex = 2 * selectedOption + 1;
        console.log('[Webhook][POST] Next stage column index:', nextStageColIndex);
        
        if (nextStageColIndex < stageRow.length) {
          nextStage = stageRow[nextStageColIndex];
          console.log('[Webhook][POST] Next stage determined:', nextStage);
          
          // Handle final stage
          if (nextStage && nextStage.toLowerCase() === 'final') {
            console.log('[Webhook][POST] Reached final stage, ending conversation');
            userStates.delete(from);
            console.log('[Webhook][POST] UserStates after deletion:', Array.from(userStates.entries()));
            
            return res.status(200).json({
              message: 'Conversation ended.',
              data: 'תודה שיצרת קשר! השיחה הסתיימה.'
            });
          }
          
          // Update user state to next stage
          if (nextStage && nextStage !== currentStage) {
            userStates.set(from, nextStage);
            currentStage = nextStage;
            console.log('[Webhook][POST] Updated user state to:', nextStage);
            console.log('[Webhook][POST] UserStates after update:', Array.from(userStates.entries()));
          }
        }
      } else {
        // Invalid option or first time user - show main menu (stage 0)
        console.log('[Webhook][POST] Invalid option or first time user - showing main menu');
        console.log('[Webhook][POST] Input analysis: selectedOption =', selectedOption, 'validOptionsCount =', validOptionsCount);
        
        // For invalid options, show error message
        if (!isNaN(selectedOption) && validOptionsCount > 0) {
          const errorMsg = `בחרת אפשרות שאינה קיימת (${selectedOption}). אנא בחר מספר בין 1 ל-${validOptionsCount}:\n`;
          const responseMessage = errorMsg + composeMessage(stageRow);
          
          console.log('[Webhook][POST] Sending error response:', responseMessage);
          return res.status(200).json({
            message: 'Invalid option selected',
            data: responseMessage
          });
        }
        
        // For non-numeric input or first time users, reset to stage 0
        userStates.set(from, '0');
        currentStage = '0';
        console.log('[Webhook][POST] Set user to initial state (stage 0)');
      }
    } else {
      // No input provided - show main menu (stage 0)
      console.log('[Webhook][POST] No input provided - showing main menu');
      userStates.set(from, '0');
      currentStage = '0';
      console.log('[Webhook][POST] Set user to initial state (stage 0)');
    }

    
    // Get final stage row for response (in case stage changed)
    const finalStageRow = sheetData.find(row => row[0] === currentStage);
    const responseMessage = composeMessage(finalStageRow);
    

    
    console.log('[Webhook][POST] Final response message:', responseMessage);
    console.log('[Webhook][POST] Final user state:', currentStage);
    console.log('[Webhook][POST] =============END REQUEST=============');

    return res.status(200).json({
      message: 'Data retrieved successfully',
      data: responseMessage
    });

if (nextStage && nextStage.toLowerCase() === 'final') {
  console.log('[Webhook][POST] Reached final stage, ending conversation');
  userStates.delete(from);
  console.log('[Webhook][POST] UserStates after deletion:', Array.from(userStates.entries()));

  // אפשר לאפס את המשתמש למצב התחלתי, או פשוט למחוק את המצב ולחכות לפנייה חדשה
  // החליפו את השורה הבאה אם רוצים לאפס:
  // userStates.set(from, '0');

  return res.status(200).json({
    message: 'Conversation ended.',
    data: 'תודה שיצרת קשר! השיחה הסתיימה.'
  });
}


  } catch (error) {
    console.error('[Webhook][POST][ERROR] Exception occurred:', error);
    console.error('[Webhook][POST][ERROR] Stack trace:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
