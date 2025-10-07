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

// משתנה גלובלי לשימור מצב המשתמשים
// const userStates = new Map();

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

// Webhook verification endpoint
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

// קבלת הודעה מ-WhatsApp ושליחת תשובה אוטומטית - תיקון שליפת מזהה משתמש וטקסט הודעה
app.post('/webhook', async (req, res) => {
    try {
        // לוג debug לבדוק מבנה ההודעה
        console.log('[DEBUG] Raw webhook:', JSON.stringify(req.body, null, 2));

        // שליפת מזהה WhatsApp מתוך contacts
        let from;
        let userInput = '';

        if (req.body.contacts && req.body.contacts.length > 0) {
            from = req.body.contacts[0].wa_id;
        }
        // גיבוי ל"חיפוש רגיל" (למקרה שיש פורמט שונה)
        if (!from && req.body.from) {
            from = req.body.from;
        }

        // שליפת ההודעה (בהנחה שב-standard היא תחת messages[0].text.body)
        if (req.body.messages && req.body.messages.length > 0 && req.body.messages[0].text && req.body.messages[0].text.body) {
            userInput = req.body.messages[0].text.body.trim();
        } else if (req.body.text && req.body.text.body) {
            userInput = req.body.text.body.trim();
        } else if (req.body.message) {
            userInput = req.body.message.trim();
        }

        if (!from) {
            console.error('[ERROR] Could not extract "from" field from webhook');
            return res.sendStatus(400);
        }

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
                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                return res.sendStatus(200);
              } else if (nextStage) {
                currentStage = nextStage;
                userStates.set(from, currentStage);
                stageRow = sheetData.find(row => row[0] === currentStage);
              } else {
                // If no valid next stage, treat as invalid input
                const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n';
                await sendWhatsappMessage(from, errorMsg);
                return res.sendStatus(200);
              }
            } else {
              // Invalid option input - resend error and options
              const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n';
              await sendWhatsappMessage(from, errorMsg);
              return res.sendStatus(200);
            }
          } else if (currentStage === '0') {
            userStates.set(from, currentStage);
          }

          const responseMessage = composeMessage(stageRow);
          console.log(`[Webhook][POST] Sending reply to ${from}:`, responseMessage);
          await sendWhatsappMessage(from,responseMessage);
          return res.sendStatus(200);

        } catch (error) {
          console.error('[Webhook] Error:', error);
          return res.status(500).json({ error: 'Internal server error', details: error.message });
        }
      });

// שליחת הודעה ל-WhatsApp API (פונקציה)
async function sendWhatsappMessage(to, message) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: message }
            },
            {
                headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
            }
        );
        console.log(`[WhatsApp][SEND] Sent to ${to}: ${message}`);
    } catch (err) {
        console.error('[WhatsApp][SEND][ERROR]', err.response ? err.response.data : err.message);
    }
}


app.listen(PORT, () => {
    console.log(`[Server] Server is listening on port ${PORT}`);
});
