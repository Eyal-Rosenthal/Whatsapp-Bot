// server.js

console.log('Starting server.js: loading required modules...');

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

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
  WHATSAPP_PHONE,
} = process.env;

// כתיבת קרדנצ'יאלז לקובץ להרשאות ה-Google Sheets
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

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth.getClient();
}

// -------- Google Sheet cache --------
let sheetDataCached = null;

async function loadBotFlowCache() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Sheet1',
  });
  sheetDataCached = res.data.values || [];
}

// טוען cache בהפעלה
loadBotFlowCache().catch(() => { sheetDataCached = null; });

// עוזר: מוצא שורה לפי מזהה מצב (עמודה 0)
function findStageRow(stageId) {
  if (!sheetDataCached) return null;
  return sheetDataCached.find(row => row[0] === stageId);
}

// עוזר: מרכיב הודעה לפי שורה (עמודה 1 = טקסט; אחר כך זוגות OptionText/Next)
function composeMessage(row) {
  if (!row || !row[1]) return 'שגיאה בטעינת הודעה';
  let msg = row[1] + '\n';
  let optionIdx = 1;
  for (let i = 2; i < row.length; i += 2) {
    const optionText = row[i];
    if (optionText && String(optionText).trim()) {
      msg += `${optionIdx}. ${optionText}\n`;
      optionIdx++;
    }
  }
  return msg.trim();
}

// עוזר: מחשב מספר אפשרויות חוקיות בשורה
function countValidOptions(row) {
  let count = 0;
  for (let i = 2; i < row.length; i += 2) {
    if (row[i] && String(row[i]).trim()) count++;
  }
  return count;
}

// עוזר: מקבל בחירה מספרית (1..n) ומחזיר מזהה המצב הבא מהעמודה המתאימה
function getNextStageBySelection(row, selectionNumber) {
  // עבור בחירה k (1-based): עמודת next תהיה ב- index = 2*k + 1
  const nextIndex = 2 * selectionNumber + 1;
  return row[nextIndex];
}

// --------- ניהול מצבים פר-משתמש ---------
// לכל משתמש נשמור אובייקט: { stage: 'id', justEnteredZero: boolean }
const userStates = new Map();

function getOrInitUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, { stage: '0', justEnteredZero: true });
  }
  return userStates.get(userId);
}

function resetToZero(userId) {
  userStates.set(userId, { stage: '0', justEnteredZero: true });
}

// -------- WhatsApp helpers --------

// חילוץ מידע מה-webhook של WhatsApp Cloud API או פורמט "פשוט"
function extractIncoming(reqBody) {
  // נסיון ל-Cloud API
  try {
    const entry = reqBody.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text = (msg.text && msg.text.body) ? msg.text.body : '';
      return { from, text };
    }
  } catch (_) {}
  // פורמט פשוט כפי שהופיע בקוד הקודם
  const from = reqBody.from || 'unknown';
  const text = reqBody.text?.body || reqBody.message || '';
  return { from, text };
}

async function sendWhatsAppText(to, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE) {
    // במידה והסביבה לא מוגדרת, לא נכשלים—רק מדפיסים לוג
    console.log('[WhatsApp] Missing token/phone. Message would be:\n', message);
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      text: { body: message },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ------------ Routes ------------

// אימות webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// הודעות נכנסות (POST)
app.post('/webhook', async (req, res) => {
  try {
    // ודא שיש cache
    if (!sheetDataCached) {
      await loadBotFlowCache();
      if (!sheetDataCached) {
        return res.status(500).json({ error: 'Failed to load bot flow data' });
      }
    }

    const { from, text } = extractIncoming(req.body);
    const userText = String(text || '').trim();
    if (!from) {
      return res.sendStatus(200); // אין למי להגיב
    }

    // שליפת מצב משתמש
    const state = getOrInitUserState(from);
    let currentStage = state.stage;

    // איתור שורת המצב
    let stageRow = findStageRow(currentStage);
    if (!stageRow) {
      // אם חסר בשיט—חוזרים ל-0
      resetToZero(from);
      stageRow = findStageRow('0');
    }

    // ניתוח בחירה
    const selectedOption = parseInt(userText, 10);
    const isValidNumber = !isNaN(selectedOption);

    // ----- לוגיקת שלב 0 -----
    if (currentStage === '0') {
      // אם זה ממש כניסה/Reset טרייה—מתעלמים מהבחירה הראשונה, מציגים תפריט, ומבטלים את הדגל
      if (state.justEnteredZero) {
        state.justEnteredZero = false;
        const menu = composeMessage(stageRow);
        await sendWhatsAppText(from, menu);
        return res.sendStatus(200);
      }

      // אם זו לא ההודעה הראשונה מאז שנכנס ל-0—כעת יש להתקדם לפי בחירה חוקית
      const validOptions = countValidOptions(stageRow);
      if (isValidNumber && selectedOption >= 1 && selectedOption <= validOptions) {
        const nextStage = getNextStageBySelection(stageRow, selectedOption);

        // טיפול ב-final
        if (nextStage && String(nextStage).toLowerCase() === 'final') {
          resetToZero(from);
          const initialRow = findStageRow('0');
          await sendWhatsAppText(from, composeMessage(initialRow));
          return res.sendStatus(200);
        }

        if (nextStage && nextStage !== currentStage) {
          state.stage = String(nextStage);
          state.justEnteredZero = false;
          stageRow = findStageRow(state.stage);
          await sendWhatsAppText(from, composeMessage(stageRow));
          return res.sendStatus(200);
        }
      }

      // בחירה לא תקינה / אין בחירה => הצגת תפריט שוב
      await sendWhatsAppText(from, composeMessage(stageRow));
      return res.sendStatus(200);
    }

    // ----- לוגיקת שלבים שאינם 0 -----
    const validOptions = countValidOptions(stageRow);
    if (isValidNumber && selectedOption >= 1 && selectedOption <= validOptions) {
      const nextStage = getNextStageBySelection(stageRow, selectedOption);

      if (nextStage && String(nextStage).toLowerCase() === 'final') {
        // הגעה לסוף — חזרה ל-0, והודעת תפריט
        resetToZero(from);
        const initialRow = findStageRow('0');
        await sendWhatsAppText(from, composeMessage(initialRow));
        return res.sendStatus(200);
      }

      if (nextStage && nextStage !== currentStage) {
        state.stage = String(nextStage);
        state.justEnteredZero = false;
        const nextRow = findStageRow(state.stage);
        await sendWhatsAppText(from, composeMessage(nextRow));
        return res.sendStatus(200);
      }
    } else {
      // טעות קלט — מציגים שגיאה + תפריט המצב הנוכחי
      const errorMsg = `בחירה לא תקינה (${userText}). אנא בחר מספר תקף מהתפריט:\n\n`;
      await sendWhatsAppText(from, errorMsg + composeMessage(stageRow));
      return res.sendStatus(200);
    }

    // אם לא בוצעה התקדמות — החזרת תפריט המצב הנוכחי
    await sendWhatsAppText(from, composeMessage(stageRow));
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook][POST][ERROR]', err);
    return res.status(500).json({ error: 'שגיאה פנימית בשרת' });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
