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

// Generate credentials.json
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

// Google Auth
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

// On boot, sanity auth test
(async () => {
    try {
        await getAuth();
        console.log('[AuthCheck] Google Auth Token is valid');
    } catch (error) {
        console.error('[AuthCheck][ERROR]', error.message);
    }
})();

// Get bot flow from Google Sheets
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

// State per user
const userStates = new Map();

// -- Utility --
function getOptions(row) {
    // לכל אפשרויות בתפריט: [טקסט, מזהה שלב הבא]
    let options = [];
    for (let i = 2; i < row.length; i += 2) {
        if (row[i] && row[i + 1]) {
            options.push({ text: row[i], next: row[i + 1] });
        }
    }
    return options;
}

function composeMessage(row) {
    let msg = row[1] + '\n';
    const options = getOptions(row);
    options.forEach((opt, idx) => {
        msg += `${idx + 1}. ${opt.text}\n`;
    });
    return msg.trim();
}

// Webhook verification
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

// --- Main webhook logic ---
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
        let stageRow = sheetData.find(row => row[0] === currentStage);
        if (!stageRow) {
            console.log(`[DEBUG] שלב לא נמצא בגיליון - reset ל-0. from=${from} currentStage=${currentStage}`);
            currentStage = '0';
            stageRow = sheetData.find(row => row[0] === currentStage);
        }

        // LOG - קלט וקונטקסט
        console.log(`[LOG][USER] from=${from} input='${userInput}' currentStage=${currentStage}`);
        console.log(`[DEBUG] stageRow: ${JSON.stringify(stageRow)}`);

        // מעבר שלבים
        if (userInput && currentStage !== '0') {
            const options = getOptions(stageRow);
            const selectedOption = parseInt(userInput, 10);
            console.log(`[DEBUG] userInput: ${userInput}, selectedOption: ${selectedOption}, optionsCount: ${options.length}`);
            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= options.length) {
                const nextStage = (options[selectedOption - 1].next || '').trim();
                console.log(`[DEBUG] nextStage שמתקבל מהאפשרות שנבחרה: ${nextStage}`);

                // סוף שיחה
                if (nextStage && (nextStage.toLowerCase() === 'final' || nextStage === '7')) {
                    userStates.delete(from);
                    const finalMessage = 'תודה ולהתראות!';
                    console.log(`[INFO] שיחה הסתיימה עם משתמש ${from}`);
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                        {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: finalMessage }
                        },
                        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                } else if (nextStage) {
                    // עדכון שלב!
                    currentStage = nextStage;
                    userStates.set(from, currentStage);
                    stageRow = sheetData.find(row => row[0] === currentStage);
                    console.log(`[SEND] מעביר משתמש ${from} לשלב ${currentStage} (${composeMessage(stageRow)})`);
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                        {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: composeMessage(stageRow) }
                        },
                        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                } else {
                    // אפשרות חוקית אך לזהות שלב הבא ריק
                    const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                    console.log(`[WARN] אפשרות חוקית אך שלב הבא ריק: from=${from}, input=${userInput}, row=${JSON.stringify(stageRow)}`);
                    await axios.post(
                        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                        {
                            messaging_product: 'whatsapp',
                            to: from,
                            text: { body: errorMsg }
                        },
                        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                    );
                    return res.sendStatus(200);
                }
            } else {
                // קלט לא חוקי
                const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                console.log(`[WARN] קלט לא חוקי: from=${from}, input=${userInput}, row=${JSON.stringify(stageRow)}`);
                await axios.post(
                    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                    {
                        messaging_product: 'whatsapp',
                        to: from,
                        text: { body: errorMsg }
                    },
                    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                );
                return res.sendStatus(200);
            }
        }

        if (currentStage === '0') {
            userStates.set(from, currentStage);
            const responseMessage = composeMessage(stageRow);
            console.log(`[SEND] שלח שלב 0 למשתמש ${from}: ${responseMessage}`);
            await axios.post(
                `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: from,
                    text: { body: responseMessage }
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
