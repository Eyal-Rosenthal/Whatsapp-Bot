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
    GCLOUD_PROJECT,
    WHATSAPP_PHONE,
} = process.env;

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

// Google Auth
async function getAuth() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        return await auth.getClient();
    } catch (err) {
        console.error('[getAuth][ERROR]', err.message || err);
        throw err;
    }
}

// בדיקה ראשונית
(async () => {
    try {
        const auth = await getAuth();
        console.log('[AuthCheck] Google Auth Token is valid');
    } catch (error) {
        console.error('[AuthCheck][ERROR]', error.message);
    }
})();

// קריאת זרימת הבוט מהגיליון
async function getBotFlow() {
    try {
        const auth = await getAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1',
        });
        return res.data.values;
    } catch (error) {
        console.error('[BotFlow][ERROR]', error);
        throw error;
    }
}

// פונקצית הרכבת ההודעה והאפשרויות למשתמש
function composeMessage(row) {
    let msg = row[1] + '\n';
    for (let i = 2, optionCount = 1; i < row.length; i += 2, optionCount++) {
        if (row[i] && row[i].trim())
            msg += `${optionCount}. ${row[i]}\n`;
    }
    return msg.trim();
}

// מפת מצבי משתמשים
const userStates = new Map();

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

app.post('/webhook', async (req, res) => {
    try {
        const entryArray = req.body.entry;
        if (!entryArray || entryArray.length === 0) return res.sendStatus(400);

        const changes = entryArray[0].changes;
        if (!changes || changes.length === 0) return res.sendStatus(400);

        const value = changes[0].value;
        if (!value || !value.messages || value.messages.length === 0) return res.sendStatus(400);

        const message = value.messages[0];
        const from = message.from;
        const userInput = (message.text && message.text.body) ? message.text.body.trim() : '';

        // קריאת הזרימה
        const sheetData = await getBotFlow();
        let currentStage = userStates.get(from) || '0';

        // מציאת שורת השלב הנוכחי
        let stageRow = sheetData.find(row => row[0] === currentStage);
        if (!stageRow) {
            currentStage = '0';
            stageRow = sheetData.find(row => row[0] === currentStage);
        }

        // ניתוח קלט המשתמש (במידה ויש)
        if (userInput && /^[0-9]+$/.test(userInput) && currentStage !== '0') {
            const selectedOption = parseInt(userInput, 10);
            const validOptionsCount = Math.floor((stageRow.length - 2) / 2);

            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                const nextStageColIndex = 2 + (selectedOption - 1) * 2 + 1;
                const nextStageVal = stageRow[nextStageColIndex];

                if (nextStageVal && nextStageVal.toLowerCase() === 'final') {
                    userStates.delete(from);
                    const finalMessage = 'תודה שיצרת קשר!';
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                        {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: finalMessage },
                        },
                        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                } else if (nextStageVal) {
                    const nextStage = nextStageVal.trim();
                    userStates.set(from, nextStage);
                    // הודעת השלב הבא
                    const nextStageRow = sheetData.find(row => row[0] === nextStage);
                    if (nextStageRow) {
                        const responseMessage = composeMessage(nextStageRow);
                        await axios.post(
                            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                            {
                                messaging_product: 'whatsapp',
                                to: from,
                                text: { body: responseMessage },
                            },
                            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                        );
                        return res.sendStatus(200);
                    }
                }
            }
            // אופציה לא תקינה או חסרה
            const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
            await axios.post(
                `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: from,
                    text: { body: errorMsg },
                },
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
            );
            return res.sendStatus(200);

        } else {
            // שליחת הודעת התחלה או אפשרויות לשלב נוכחי
            userStates.set(from, currentStage);
            const responseMessage = composeMessage(stageRow);
            await axios.post(
                `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: from,
                    text: { body: responseMessage },
                },
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
            );
            return res.sendStatus(200);
        }
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Server] Server is listening on port ${PORT}`);
});
