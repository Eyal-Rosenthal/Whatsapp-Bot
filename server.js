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

const userStates = new Map(); // In-memory user states (stage per user)

// Handle incoming messages
app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Incoming message:', JSON.stringify(req.body));

  try {
    const from = req.body.from || 'unknown';
    let userInput = '';

    if (req.body.text && req.body.text.body) userInput = req.body.text.body.trim();
    else if (req.body.message) userInput = req.body.message.trim();

    // Get current user stage or start at '0'
    let currentStage = userStates.get(from) || '0';

    // Parse sheet data
    const sheetData = await getBotFlow();

    // Find the row for the current stage
    let stageRow = sheetData.find(row => row[0] === currentStage);

    if (!stageRow) {
      // If no stage found, reset conversation
      currentStage = '0';
      stageRow = sheetData.find(row => row[0] === currentStage);
    }

    // If user sent a number and it's not the first message of the conversation,
    // update stage accordingly to the next stage from the selected option.
    if (userInput && currentStage !== '0') {
      const selectedOptionIndex = parseInt(userInput, 10);
      if (!isNaN(selectedOptionIndex) && selectedOptionIndex > 0) {
        // Calculate columns in sheet: option names at col 2,4,... next stages col 3,5,...
        const optionStageIndex = 2 * selectedOptionIndex + 1; // e.g. option 1 -> col 3, option 2 -> col 5
        const nextStage = stageRow[optionStageIndex];

        if (nextStage && nextStage.toLowerCase() === 'final') {
          // Reset conversation state when final stage reached
          userStates.delete(from);
          res.status(200).json({ message: 'Conversation ended.', data: 'תודה שיצרת קשר!' });
          return;
        } else if (nextStage) {
          // Move to next stage
          currentStage = nextStage;
          userStates.set(from, currentStage);
          stageRow = sheetData.find(row => row[0] === currentStage);
        } else {
          // Invalid option selected, keep current stage
          console.warn(`[Webhook] User ${from} selected invalid option: ${selectedOptionIndex}`);
        }
      }
    } else if (currentStage === '0') {
      // On first user message, record state
      userStates.set(from, currentStage);
    }

    // Compose response message from the current stage row
    let responseMessage = stageRow ? `${stageRow[1]}\n` : 'שלום, איך אפשר לעזור?';

    if (stageRow) {
      // Compose options list (two options per row, option col 2 and 4)
      for (let i = 2; i < stageRow.length; i += 2) {
        if (stageRow[i]) {
          const optionNumber = (i / 2);
          responseMessage += `${optionNumber}. ${stageRow[i]}\n`;
        }
      }
    }

    console.log(`[Webhook][POST] Sending reply to ${from}:`, responseMessage);

    res.status(200).json({
      message: 'Data retrieved successfully',
      data: responseMessage,
    });

  } catch (error) {
    console.error('Webhook error:', error);
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
