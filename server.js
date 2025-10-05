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


// מפת מצבי משתמש
const userStates = new Map();


// טיפול בהודעות הנכנסות מה-Webhook של WhatsApp
app.post('/webhook', async (req, res) => {
  console.log('[Webhook][POST] Incoming WhatsApp notification:', JSON.stringify(req.body, null, 2));
  
  try {
    // מבנה הודעת WhatsApp API
    // Nachrichten יהיו ב: req.body.entry[x].changes[x].value.messages[x]
    const entryArray = req.body.entry;
    if (!entryArray || entryArray.length === 0) {
      console.warn('[Webhook][POST] No entry array in request body');
      return res.sendStatus(400);
    }
    
    // עבור כל שינוי ב-entry - לרוב יש אחד
    const changes = entryArray[0].changes;
    if (!changes || changes.length === 0) {
      console.warn('[Webhook][POST] No changes array in request body');
      return res.sendStatus(400);
    }
    
    const value = changes[0].value;
    if (!value || !value.messages || value.messages.length === 0) {
      console.warn('[Webhook][POST] No messages array in request body value');
      return res.sendStatus(400);
    }
    
    const message = value.messages[0];
    const from = message.from; // המספר ששולח את ההודעה
    const userInput = (message.text && message.text.body) ? message.text.body.trim() : '';
    console.log(`[Webhook][POST] Received message from: ${from}, content: "${userInput}"`);
    
    // קריאת נתוני הבוט מהגיליון
    const sheetData = await getBotFlow();
    
    // קבלת מצב המשתמש הנוכחי או התחלת מצב '0'
    let currentStage = userStates.get(from) || '0';
    
    // מציאת שורת השלב הנוכחי בגיליון
    let stageRow = sheetData.find(row => row[0] === currentStage);
    
    if (!stageRow) {
      currentStage = '0';
      stageRow = sheetData.find(row => row[0] === currentStage);
    }
    
    // פונקציה הרכבת הודעה לפי שורה
    function composeMessage(row) {
      let msg = row[1] + '\n';
      for (let i = 2, optionCount = 1; i < row.length; i += 2, optionCount++) {
        if (row[i]) msg += `${optionCount}. ${row[i]}\n`;
      }
      return msg.trim();
    }
    
    // ניתוח קלט המשתמש כאופציה במספר, רק אם לא בשלב '0'
    if (userInput && currentStage !== '0') {
      const selectedOption = parseInt(userInput, 10);
      const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
      
      if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
        const nextStageColIndex = 2 * selectedOption + 1;
        const nextStage = stageRow[nextStageColIndex];
        
        if (nextStage?.toLowerCase() === 'final') {
          userStates.delete(from);
          
          // שליחת הודעת סיום
          const finalMessage = 'תודה שיצרת קשר!';
          console.log(`[Webhook][POST] Sending final reply to ${from}: ${finalMessage}`);
          
          await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: finalMessage },
            },
            {
              headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
            }
          );
          
          return res.sendStatus(200);
        } else if (nextStage) {
          currentStage = nextStage;
          userStates.set(from, currentStage);
          stageRow = sheetData.find(row => row[0] === currentStage);
        } else {
          const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
          console.log(`[Webhook][POST] Invalid option selected by ${from}, resending options`);
          await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: errorMsg },
            },
            {
              headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
            }
          );
          return res.sendStatus(200);
        }
      } else {
        // קלט לא חוקי - הודעת שגיאה עם אפשרויות
        const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
        console.log(`[Webhook][POST] Invalid input from ${from}, sending error reply`);
        await axios.post(
          `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: errorMsg },
          },
          {
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
          }
        );
        return res.sendStatus(200);
      }
    } else if (currentStage === '0') {
      userStates.set(from, currentStage);
    }
    
    // יצירת הודעה לפי השלב הנוכחי
    const responseMessage = composeMessage(stageRow);
    
    console.log(`[Webhook][POST] Sending reply to ${from}:`, responseMessage);
    
    // שליחת הודעה חזרה דרך API של WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
      {
        messaging_product: 'whatsapp',
        to: from,
        text: { body: responseMessage },
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      }
    );
    
    return res.sendStatus(200);
  } catch (error) {
    console.error('[Webhook][POST][ERROR]', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});


app.listen(PORT, () => {
  console.log(`[Server] Server is listening on port ${PORT}`);
});
