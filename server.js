const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

console.log('Required modules loaded successfully');
const app = express();
app.use(bodyParser.json());

// משתני סביבה
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

// יצירת credentials.json
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

// שמירת סטטוסים למשתמשים
const userStates = new Map();

// פקציית AUTH של גוגל
async function getAuth() {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return await auth.getClient();
}

// קריאת Google Sheets
async function getBotFlow() {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1',
    });
    return res.data.values;
}

// פונקציה לבניית הודעת התשובה עם אפשרויות
function composeMessage(row) {
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i]) msg += `${count}. ${row[i]}\n`;
    }
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




///////////////////////////////////////////////////////////////////////////////////////////////
app.post('/webhook', async (req, res) => {
    try {
        console.log('[DEBUG] req.body:', JSON.stringify(req.body, null, 2));
        // טיפול רק ב-eventים מסוג messages
        const entry = req.body.entry;
        if (!entry || !Array.isArray(entry)) return res.sendStatus(400);

        for (const ent of entry) {
            const changes = ent.changes;
            if (!changes || !Array.isArray(changes)) continue;

            for (const change of changes) {
                const value = change.value;
                if (value && value.messages && Array.isArray(value.messages)) {
                    for (const message of value.messages) {
                        const from = message.from;
                        const userInput = message.text && message.text.body ? message.text.body.trim() : '';

                        if (!from) {
                            console.error('[ERROR] "from" missing in message object');
                            continue;
                        }

                        let currentStage = userStates.get(from) || '0';
                        const sheetData = await getBotFlow();
                        let stageRow = sheetData.find(row => row[0] === currentStage);
                        if (!stageRow) {
                            currentStage = '0';
                            stageRow = sheetData.find(row => row[0] === currentStage);
                        }

                        function composeMessage(row) {
                            let msg = row[1] + '\n';
                            for (let i = 2, count = 1; i < row.length; i += 2, count++) {
                                if (row[i]) msg += `${count}. ${row[i]}\n`;
                            }
                            return msg.trim();
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
                                    continue;
                                } else if (nextStage) {
                                    currentStage = nextStage;
                                    userStates.set(from, currentStage);
                                    stageRow = sheetData.find(row => row[0] === currentStage);
                                } else {
                                    const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                                    await sendWhatsappMessage(from, errorMsg);
                                    continue;
                                }
                            } else {
                                const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                                await sendWhatsappMessage(from, errorMsg);
                                continue;
                            }
                        }
                        // שליחת שלב ראשון
                        if (currentStage === '0') {
                            userStates.set(from, currentStage);
                        }
                        const responseMessage = composeMessage(stageRow);
                        await sendWhatsappMessage(from, responseMessage);
                    }
                }
            }
        }
        return res.sendStatus(200);

    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});
////////////////////////////////////////////////////////////////////////////////////////////////
/*
// Webhook handler - למבנה הפשוט שלך בלבד
app.post('/webhook', async (req, res) => {
    try {
        console.log('[DEBUG] req.body:', JSON.stringify(req.body, null, 2));

        // שליפה פשוטה ממבנה שטוח (מותאם ללוגים שלך בלבד!)
        const from = req.body.from;
        const userInput = req.body.body ? req.body.body.trim() : '';

        if (!from) {
            console.error('[ERROR] "from" is missing in webhook request');
            return res.sendStatus(400);
        }

        let currentStage = userStates.get(from) || '0';
        const sheetData = await getBotFlow();

        let stageRow = sheetData.find(row => row[0] === currentStage);
        if (!stageRow) {
            currentStage = '0';
            stageRow = sheetData.find(row => row[0] === currentStage);
        }

        // ניהול מעבר שלבים
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

        // שליחת שלב ראשוני או כל שלב מחדש
        if (currentStage === '0') {
            userStates.set(from, currentStage);
        }
        const responseMessage = composeMessage(stageRow);
        await sendWhatsappMessage(from, responseMessage);
        return res.sendStatus(200);

    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});*/

// שליחת הודעה ל-WhatsApp API
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
