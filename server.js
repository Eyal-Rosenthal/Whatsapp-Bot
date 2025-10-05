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

// user state
const userStates = new Map();

// גמיש: מייצר אופציות מכל זוג [טקסט, מזהה שלב], עם טיפול עמיד ל-undefined ורווחים
function getOptions(row) {
    let options = [];
    for (let i = 2; i < row.length; i += 2) {
        const nextStageVal = (row[i+1] !== undefined && row[i+1] !== null) ? row[i+1].toString().trim() : '';
        if (nextStageVal !== '') {
            options.push({
                text: row[i] ? row[i].toString().trim() : '',
                next: nextStageVal
            });
        }
    }
    return options;
}
function composeMessage(row) {
    let msg = row[1] ? row[1].toString().trim() + '\n' : '';
    const options = getOptions(row);
    options.forEach((opt, idx) => {
        msg += `${idx + 1}. ${opt.text}\n`;
    });
    return msg.trim();
}

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const entryArray = req.body.entry;
        if (!entryArray || entryArray.length === 0) return res.sendStatus(200);
        const changes = entryArray[0].changes;
        if (!changes || changes.length === 0) return res.sendStatus(200);
        const value = changes[0].value;
        if (!value || !value.messages || value.messages.length === 0) return res.sendStatus(200);
        const message = value.messages[0];

        if (!message.text || !message.text.body || !message.text.body.trim()) return res.sendStatus(200);

        const from = message.from;
        const userInput = message.text.body.trim();
        const sheetData = await getBotFlow();

        let currentStage = userStates.get(from) || '0';
        let stageRow = sheetData.find(row => 
            row[0] !== undefined && row[0] !== null && row[0].toString().trim() === currentStage
        );

        if (!stageRow) {
            currentStage = '0';
            stageRow = sheetData.find(row => 
                row[0] !== undefined && row[0] !== null && row[0].toString().trim() === currentStage
            );
        }

        // מעבר שלבים בפועל רק אם יש קלט מתאים
        if (userInput && currentStage !== '0') {
            const options = getOptions(stageRow);
            const selectedOption = parseInt(userInput, 10);
            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= options.length) {
                const nextStage = options[selectedOption - 1].next;
                if (nextStage && (nextStage.toLowerCase() === 'final' || nextStage === '7')) {
                    userStates.delete(from);
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: 'תודה ולהתראות!' }
                        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                } else if (nextStage) {
                    currentStage = nextStage;
                    userStates.set(from, currentStage);
                    stageRow = sheetData.find(row => 
                        row[0] !== undefined && row[0] !== null && row[0].toString().trim() === currentStage
                    );
                    if (!stageRow) {
                        await axios.post(
                            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                                messaging_product: 'whatsapp',
                                to: from,
                                text: { body: 'שגיאת מערכת: שלב לא נמצא.' }
                            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                        );
                        return res.sendStatus(200);
                    }
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: composeMessage(stageRow) }
                        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                } else {
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: 'בחרת אפשרות שאינה קיימת, נסה שוב:\n' + composeMessage(stageRow) }
                        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                }
            } else {
                await axios.post(
                    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                        messaging_product: 'whatsapp',
                        to: from,
                        text: { body: 'בחרת אפשרות לא חוקית, נסה שוב:\n' + composeMessage(stageRow) }
                    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                );
                return res.sendStatus(200);
            }
        }

        // שליחה ראשונית
        if (currentStage === '0') {
            userStates.set(from, currentStage);
            await axios.post(
                `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`, {
                    messaging_product: 'whatsapp',
                    to: from,
                    text: { body: composeMessage(stageRow) }
                }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
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
