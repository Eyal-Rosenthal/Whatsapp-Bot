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

const userStates = new Map();

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
    return msg.trim();
}

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

/////////////////////////////////////////////////////////////////////////////////////////////////////////
app.post('/webhook', async (req, res) => {
    try {
        const entries = req.body.entry || [];
        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const value = change.value || {};
                if (!Array.isArray(value.messages)) continue;
                for (const message of value.messages) {
                    if (message.type !== 'text' || !message.from || !message.text || !message.text.body) continue;

                    const from = message.from.trim();
                    const userInput = message.text.body.trim();
                    let currentStage = userStates.get(from) || '0';
                    const sheetData = await getBotFlow();
                    let stageRow = sheetData.find(row => row[0] === currentStage);
                    if (!stageRow) {
                        currentStage = '0';
                        stageRow = sheetData.find(row => row[0] === '0');
                        userStates.set(from, '0');
                    }

                    //--------- טיפול נכון במצב 0: ---------
                    if (currentStage === '0') {
                        // בדוק אם המשתמש שלח קלט של מספר תקף במצב 0
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            // מעבר שלב מהמסך הראשי למצב נבחר
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                    continue;
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                    continue;
                                }
                            }
                        }
                        // אם המשתמש לא הכניס בחירה, שולחים לו שוב את ההודעה של מצב 0
                        userStates.set(from, '0');
                        const responseMessage = composeMessage(stageRow);
                        await sendWhatsappMessage(from, responseMessage);
                        continue;
                    }

                    //--------- טיפול במצבים כלליים (לא 0): ---------
                    if (currentStage !== '0') {
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                    continue;
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                    continue;
                                }
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
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});


///////////////////////////////////////////////////////////////////////////////////////////////////////////

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
