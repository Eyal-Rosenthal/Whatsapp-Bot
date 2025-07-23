require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const sheetId = process.env.GOOGLE_SHEET_ID;

// טעינת credentials (keyfile.json) שיצרת ל-service-account
const auth = new google.auth.GoogleAuth({
  keyFile: 'keyfile.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function getBotFlow() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1',
  });
  return res.data.values;
}

function parseUserStep(userState, sheetData) {
  const stages = {};
  for (let i=1; i < sheetData.length; i++) {
    const row = sheetData[i];
    stages[row[0]] = row;
  }
  return stages[userState];
}

app.post('/webhook', async (req, res) => {
  // WhatsApp sends an event with message
  const body = req.body;
  try {
    const sheetData = await getBotFlow();
    // כאן הבוט אמור לשמור מצב משתמש - אפשר דרך DB קטנה, קובץ, או בתוך התגובה עצמה (state).
    let userState = '0'; // להתחלה; בפועל תקצה כל משתמש סטייט משלו
    const userRow = parseUserStep(userState, sheetData);
    // בניית הודעה דינאמית מה-Google Sheet
    let message = userRow[1] + '\n';
    if (userRow[2]) message += `1. ${userRow[2]}\n`;
    if (userRow[4]) message += `2. ${userRow[4]}\n`;
    // שלח חזרה ב-WhatsApp
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: +972544736044,
      text: { body: message },
    }, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT, () =>
  console.log(`Bot listening on port ${process.env.PORT}`));
