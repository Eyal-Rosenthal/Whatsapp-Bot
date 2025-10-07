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
const endedSessions = new Set();
const mustSendIntro = new Set();

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

                    // התחלת סשן חדש (או אחרי סיום) – שולח פתיחה בלבד, לא משנה מה הגיע
                    if (
                        endedSessions.has(from) ||
                        !userStates.has(from) ||
                        mustSendIntro.has(from)
                    ) {
                        if (!mustSendIntro.has(from)) {
                            endedSessions.delete(from);
                            userStates.set(from, '0');
                            mustSendIntro.add(from);
                        }
                        const sheetData = await getBotFlow();
                        const stageRow = sheetData.find(row => row[0] === '0');
                        if (stageRow) {
                            const responseMessage = composeMessage(stageRow);
                            await sendWhatsappMessage(from, responseMessage);
                        }
                        // לא מוחקים כאן את הדגל! הוא יימחק רק בהודעה הבאה.
                        continue;
                    }

                    // כאן מתחילים לעבד הודעות "שנייה" והלאה—נטרל את הדגל
                    if (mustSendIntro.has(from)) {
                        mustSendIntro.delete(from);
                        continue;
                    }

                    let currentStage = userStates.get(from) || '0';
                    const sheetData = await getBotFlow();
                    let stageRow = sheetData.find(row => row[0] === currentStage);

                    if (!stageRow) {
                        currentStage = '0';
                        stageRow = sheetData.find(row => row[0] === '0');
                        userStates.set(from, '0');
                    }

                    // שלב סיום: רק 2 תאים
                    if (stageRow.length === 2) {
                        userStates.delete(from);
                        endedSessions.add(from);
                        await sendWhatsappMessage(from, stageRow[1]);
                        continue;
                    }

                    // שלב 0: חזור כאן!
                    if (currentStage === '0') {
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);

                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                endedSessions.add(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew && stageRowNew.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, stageRowNew[1]);
                                } else if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                                continue;
                            }
                        }
                        // ==== תיקון: שליחת הודעת שגיאה + פתיחה ====
                        const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                        await sendWhatsappMessage(from, errorMsg);
                        continue;
                    }

                    // שלבים מתקדמים
                    if (currentStage !== '0') {
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                endedSessions.add(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew && stageRowNew.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, stageRowNew[1]);
                                } else if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                                continue;
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

////////////////////////////////////////////////////////////////////////////////////////////////////////////
/*
const endedSessions = new Set();
const mustSendIntro = new Set();

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

                    // התחלת סשן חדש (או אחרי סיום) – שולח פתיחה בלבד, לא משנה מה הגיע
                    if (
                        endedSessions.has(from) ||
                        !userStates.has(from) ||
                        mustSendIntro.has(from)
                    ) {
                        // למשתמש חדש – מוסיפים אותו ל־mustSendIntro (לא מוחקים בשלב זה)
                        if (!mustSendIntro.has(from)) {
                            endedSessions.delete(from);
                            userStates.set(from, '0');
                            mustSendIntro.add(from);
                        }
                        const sheetData = await getBotFlow();
                        const stageRow = sheetData.find(row => row[0] === '0');
                        if (stageRow) {
                            const responseMessage = composeMessage(stageRow);
                            await sendWhatsappMessage(from, responseMessage);
                        }
                        // *לא* למחוק כאן את הדגל! הוא יימחק רק בהודעה הבאה.
                        continue;
                    }

                    // כאן מתחילים לעבד הודעות "שנייה" והלאה—נטרל את הדגל
                    if (mustSendIntro.has(from)) {
                        mustSendIntro.delete(from);
                        continue;
                    }

                    let currentStage = userStates.get(from) || '0';
                    const sheetData = await getBotFlow();
                    let stageRow = sheetData.find(row => row[0] === currentStage);

                    if (!stageRow) {
                        currentStage = '0';
                        stageRow = sheetData.find(row => row[0] === '0');
                        userStates.set(from, '0');
                    }

                    // שלב סיום: רק 2 תאים
                    if (stageRow.length === 2) {
                        userStates.delete(from);
                        endedSessions.add(from);
                        await sendWhatsappMessage(from, stageRow[1]);
                        continue;
                    }

                    // שלב 0: תגובה רגילה
                    if (currentStage === '0') {
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);

                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                endedSessions.add(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew && stageRowNew.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, stageRowNew[1]);
                                } else if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                                continue;
                            }
                        }
                        // אין בחירה: חזור על מסך פתיחה
                        const responseMessage = composeMessage(stageRow);
                        await sendWhatsappMessage(from, responseMessage);
                        continue;
                    }

                    // שלבים מתקדמים
                    if (currentStage !== '0') {
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                endedSessions.add(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                continue;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const stageRowNew = sheetData.find(row => row[0] === nextStage);
                                if (stageRowNew && stageRowNew.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, stageRowNew[1]);
                                } else if (stageRowNew) {
                                    const responseMessage = composeMessage(stageRowNew);
                                    await sendWhatsappMessage(from, responseMessage);
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                                continue;
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
});*/

////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
