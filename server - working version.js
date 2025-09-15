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



// Handle incoming messages
const userStates = new Map();

app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body));

  try {
    const from = req.body.from || 'unknown';

    let userInput = '';
    if (req.body.text && req.body.text.body) userInput = req.body.text.body.trim();
    else if (req.body.message) userInput = req.body.message.trim();

    let currentStage = userStates.get(from) || '0';

    const sheetData = await getBotFlow();

    // Find current stage row
    let stageRow = sheetData.find(row => row[0] === currentStage);

    if (!stageRow) {
      currentStage = '0';
      stageRow = sheetData.find(row => row[0] === currentStage);
    }

    // Function to compose message with options from a stageRow
    function composeMessage(row) {
      let msg = row[1] + '\n';
      for (let i = 2, optionCount = 1; i < row.length; i += 2, optionCount++) {
        if (row[i]) msg += `${optionCount}. ${row[i]}\n`;
      }
      return msg;
    }

    // Trying to parse user input as option number, only if currentStage not '0'
    if (userInput && currentStage !== '0') {
      const selectedOption = parseInt(userInput, 10);

      // Number of valid options in this stage
      const validOptionsCount = Math.floor((stageRow.length - 2) / 2);

      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        // Calculate next stage column index:
        // options start at col 2 and 4 etc., next stage col is next column (3,5,...)
        const nextStageColIndex = 2 * selectedOption + 1;
        const nextStage = stageRow[nextStageColIndex];

        if (nextStage?.toLowerCase() === 'final') {
          // End conversation and reset
          userStates.delete(from);
          return res.status(200).json({
            message: 'Conversation ended.',
            data: 'תודה שיצרת קשר!'
          });
        } else if (nextStage) {
          currentStage = nextStage;
          userStates.set(from, currentStage);
          stageRow = sheetData.find(row => row[0] === currentStage);
        } else {
          // If no valid next stage, treat as invalid input
          const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n';
          return res.status(200).json({
            message: errorMsg + composeMessage(stageRow),
            data: errorMsg + composeMessage(stageRow)
          });
        }
      } else {
        // Invalid option input - resend error and options
        const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n';
        return res.status(200).json({
          message: errorMsg + composeMessage(stageRow),
          data: errorMsg + composeMessage(stageRow)
        });
      }
    } else if (currentStage === '0') {
      userStates.set(from, currentStage);
    }

    const responseMessage = composeMessage(stageRow);

    console.log(`[Webhook][POST] Sending reply to ${from}:`, responseMessage);

    return res.status(200).json({
      message: 'Data retrieved successfully',
      data: responseMessage
    });

  } catch (error) {
    console.error('[Webhook] Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
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
