const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// משתנה גלובלי לשימור מצב המשתמשים
const userStates = new Map();

// משתני סביבה ...
const {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PORT = 8080,
    GOOGLE_SHEET_ID,
    WHATSAPP_PHONE,
    type,
    project_id,
    private_key_id,
    private_key,
    client_email,
    client_id,
    auth_uri,
    token_uri,
    auth_provider_x509_cert_url,
    client_x509_cert_url
} = process.env;

// יצירת credentials.json בזמן ריצה
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
    client_x509_cert_url
};
const keyFilePath = path.join(__dirname, 'credentials.json');
fs.writeFileSync(keyFilePath, JSON.stringify(credentials));

// גישה ל-Google Sheets
async function getAuth() {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return await auth.getClient();
}

async function getBotFlow() {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1',
    });
    return res.data.values;
}

function composeMessage(row) {
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i]) msg += `${count}. ${row[i]}\n`;
    }
    return msg;
}

// אימות webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    } else {
        return res.sendStatus(403);
    }
});

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
        let stageRow = sheetData.find(row => row[0] === currentStage);
        if (!stageRow) {
            currentStage = '0';
            stageRow = sheetData.find(row => row[0] === currentStage);
        }

        if (userInput && currentStage !== '0') {
            const selectedOption = parseInt(userInput, 10);
            const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                const nextStageColIndex = 2 * selectedOption + 1;
                const nextStage = stageRow[nextStageColIndex];
                if (nextStage?.toLowerCase() === 'final') {
                    userStates.delete(from);
                    await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                    return res.sendStatus(200);
                } else if (nextStage) {
                    currentStage = nextStage;
                    userStates.set(from, currentStage);
                    stageRow = sheetData.find(row => row[0] === currentStage);
                } else {
                    const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                    await sendWhatsappMessage(from, errorMsg);
                    return res.sendStatus(200);
                }
            } else {
                const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                await sendWhatsappMessage(from, errorMsg);
                return res.sendStatus(200);
            }
        }

        if (currentStage === '0') {
            // שומר את מצב התחלה
            userStates.set(from, currentStage);
            const responseMessage = composeMessage(stageRow);
            await sendWhatsappMessage(from, responseMessage);
            return res.sendStatus(200);
        }
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
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
