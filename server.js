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
const endedSessions = new Set();
const mustSendIntro = new Set();
const userAnswers = new Map(); // profile per user (optional)

let botFlowData = null;
const BOTFLOW_JSON = path.join(__dirname, 'botflow.json');

async function loadBotFlowData() {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1',
    });
    botFlowData = res.data.values
        .filter(row => row[0] && String(row[0]).trim() && String(row[0]).toLowerCase() !== 'stage'); // מסנן כותרות/שורות ריקות
    fs.writeFileSync(BOTFLOW_JSON, JSON.stringify(botFlowData, null, 2), 'utf8');
    console.log('[Loaded] Bot flow loaded into RAM and botflow.json');
}

// ===== Queue =====
const userQueues = new Map();

function enqueueUserTask(from, task) {
    if (!userQueues.has(from)) userQueues.set(from, []);
    const queue = userQueues.get(from);
    queue.push(task);
    if (queue.length === 1) runNextTask(from);
}

function runNextTask(from) {
    const queue = userQueues.get(from);
    if (!queue || queue.length === 0) return;
    const nextTask = queue[0];
    nextTask().finally(() => {
        queue.shift();
        if (queue.length > 0) runNextTask(from);
        else userQueues.delete(from);
    });
}

function composeMessage(row) {
    if (row.length > 2 && /^\[.*\]/.test(row[2])) return row[1];
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i] && !/^\[.*\]/.test(row[i])) msg += `${count}. ${row[i]}\n`;
    }
    return msg.trim();
}


async function sendWhatsappMessage(to, message) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            { messaging_product: 'whatsapp', to, text: { body: message } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (err) {
        console.error('[WhatsApp][SEND][ERROR]', err.response ? err.response.data : err.message);
    }
}

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN)
        return res.status(200).send(challenge);
    else
        return res.sendStatus(403);
});

                    app.post('/webhook', async (req, res) => {
                        try {
                            const entries = req.body.entry || [];
                            for (const entry of entries) {
                                const changes = entry.changes || [];
                                for (const change of changes) {
                                    const value = change.value || {};
                                    if (!Array.isArray(value.messages)) continue;
                                    for (const message of value.messages) {
                                        if (
                                            message.type !== 'text' ||
                                            !message.from ||
                                            !message.text ||
                                            !message.text.body
                                        )
                                            continue;
                                        const from = message.from.trim();
                                        const userInput = message.text.body.trim();

                    enqueueUserTask(from, async () => {

                        if (endedSessions.has(from) || !userStates.has(from)) {
                            endedSessions.delete(from);
                            userStates.set(from, '0');
                            mustSendIntro.add(from);
                            const stageRow = botFlowData.find(row => String(row[0]) === '0');
                            if (stageRow) await sendWhatsappMessage(from, stageRow[1]); // מציג רק את הכותרת של שלב 0
                            return;
                        }
                        if (mustSendIntro.has(from)) {
                            mustSendIntro.delete(from);
                            return;
                        }

                        let currentStage = userStates.get(from) || '0';
                        console.log(`[FLOW DEBUG] from:${from}, currentStage:${currentStage}, state:[${userStates.get(from)}], input:${userInput}`);

                        // (1) אם המשתמש במצב AWAITING_TEXT — זה שלב טקסט חופשי
                        if (String(currentStage).endsWith('_AWAITING_TEXT')) {
                            const baseStage = currentStage.replace('_AWAITING_TEXT', '');
                            const stageRowBase = botFlowData.find(row => String(row[0]) === baseStage);

                            if (!userAnswers.has(from)) userAnswers.set(from, {});
                            const fieldName = stageRowBase[1].replace(/[\[\]]/g, '').trim();
                            userAnswers.get(from)[fieldName] = userInput;

                            // עוברים לשלב הבא:
                            const nextStage = stageRowBase[2];
                            if (nextStage) {
                                userStates.set(from, nextStage);
                                const nextRow = botFlowData.find(row => String(row[0]) === nextStage);
                                if (nextRow && nextRow.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, nextRow[1]);
                                } else if (nextRow) {
                                    // בודק אם גם זה טקסט חופשי
                                    if (/^\[.*\]/.test(nextRow[1])) {
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        userStates.set(from, nextStage + '_AWAITING_TEXT');
                                        if (String(currentStage).endsWith('_AWAITING_TEXT')) {
                                        console.log(`[AWAITING TEXT] קלט חופשי מ-${from}: ${userInput}`);
                                        }
                                    } else {
                                        await sendWhatsappMessage(from, composeMessage(nextRow));
                                    }
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                            }
                            return;
                        }

                        let stageRow = botFlowData.find(row => String(row[0]) === currentStage);
                        if (!stageRow) {
                            await sendWhatsappMessage(from, `אירעה שגיאה פנימית - שלב ${currentStage} לא נמצא!`);
                            return;
                        }

                        // (2) אם זה שלב סיום
                        if (stageRow.length === 2) {
                            userStates.delete(from);
                            endedSessions.add(from);
                            await sendWhatsappMessage(from, stageRow[1]);
                            return;
                        }

                        // (3) אם זה שלב קלט טקסט
                        if (
                            stageRow.length >= 3 &&
                            /^\[.*\]/.test(stageRow[2])
                        ) {
                            await sendWhatsappMessage(from, stageRow[1]); // מציג רק את הכותרת
                            userStates.set(from, currentStage + '_AWAITING_TEXT');
                            return;
                        }

                        // (4) שלב בחירה רגיל (מספרים/אפשרויות)
                        const selectedOption = parseInt(userInput, 10);
                        const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                        if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                            const nextStageColIndex = 2 * selectedOption + 1;
                            const nextStage = stageRow[nextStageColIndex];
                            if (nextStage && nextStage.toLowerCase() === 'final') {
                                userStates.delete(from);
                                endedSessions.add(from);
                                await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                return;
                            } else if (nextStage) {
                                userStates.set(from, nextStage);
                                const nextRow = botFlowData.find(row => String(row[0]) === nextStage);
                                if (nextRow && nextRow.length === 2) {
                                    userStates.delete(from);
                                    endedSessions.add(from);
                                    await sendWhatsappMessage(from, nextRow[1]);
                                } else if (nextRow) {
                                    if (/^\[.*\]/.test(nextRow[1])) {
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        userStates.set(from, nextStage + '_AWAITING_TEXT');
                                    } else {
                                        await sendWhatsappMessage(from, composeMessage(nextRow));
                                    }
                                } else {
                                    await sendWhatsappMessage(from, 'אירעה שגיאה - שלב לא מזוהה!');
                                }
                            }
                            return;
                        }
                        // קלט לא חוקי או לא מספר באפשרויות:
                        const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                        await sendWhatsappMessage(from, errorMsg);
                    });
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

loadBotFlowData().then(() => {
    app.listen(PORT, () => {
        console.log(`[Server] Server is listening on port ${PORT}`);
    });
}).catch(err => {
    console.error('[Startup][Sheet][ERROR]', err);
});



/*const fs = require('fs');
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
const endedSessions = new Set();
const mustSendIntro = new Set();

let botFlowData = null;
const BOTFLOW_JSON = path.join(__dirname, 'botflow.json');

async function loadBotFlowData() {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1',
    });
    botFlowData = res.data.values;
    fs.writeFileSync(BOTFLOW_JSON, JSON.stringify(botFlowData, null, 2), 'utf8');
    console.log('[Loaded] Bot flow loaded into RAM and botflow.json');
}

// ===== Queue =====
const userQueues = new Map();

function enqueueUserTask(from, task) {
    if (!userQueues.has(from)) userQueues.set(from, []);
    const queue = userQueues.get(from);
    queue.push(task);
    if (queue.length === 1) runNextTask(from);
}

function runNextTask(from) {
    const queue = userQueues.get(from);
    if (!queue || queue.length === 0) return;
    const nextTask = queue[0];
    nextTask().finally(() => {
        queue.shift();
        if (queue.length > 0) runNextTask(from);
        else userQueues.delete(from);
    });
}

function composeMessage(row) {
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i]) msg += `${count}. ${row[i]}\n`;
    }
    return msg.trim();
}

async function sendWhatsappMessage(to, message) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
            { messaging_product: 'whatsapp', to, text: { body: message } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (err) {
        console.error('[WhatsApp][SEND][ERROR]', err.response ? err.response.data : err.message);
    }
}

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN)
        return res.status(200).send(challenge);
    else
        return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const entries = req.body.entry || [];
        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const value = change.value || {};
                if (!Array.isArray(value.messages)) continue;
                for (const message of value.messages) {
                    if (
                        message.type !== 'text' ||
                        !message.from ||
                        !message.text ||
                        !message.text.body
                    )
                        continue;
                    const from = message.from.trim();
                    const userInput = message.text.body.trim();

                    enqueueUserTask(from, async () => {

                        if (endedSessions.has(from) || !userStates.has(from)) {
                            endedSessions.delete(from);
                            userStates.set(from, '0');
                            mustSendIntro.add(from);
                            const stageRow = botFlowData.find(row => row[0] === '0');
                            if (stageRow) {
                                const responseMessage = composeMessage(stageRow);
                                await sendWhatsappMessage(from, responseMessage);
                            }
                            return;
                        }
                        if (mustSendIntro.has(from)) {
                            mustSendIntro.delete(from);
                            return;
                        }

                        let currentStage = userStates.get(from) || '0';
                        let stageRow = botFlowData.find(row => row[0] === currentStage);

                        if (!stageRow) {
                            currentStage = '0';
                            stageRow = botFlowData.find(row => row[0] === '0');
                            userStates.set(from, '0');
                        }

                        if (stageRow.length === 2) {
                            userStates.delete(from);
                            endedSessions.add(from);
                            await sendWhatsappMessage(from, stageRow[1]);
                            return;
                        }

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
                                    return;
                                } else if (nextStage) {
                                    userStates.set(from, nextStage);
                                    const stageRowNew = botFlowData.find(row => row[0] === nextStage);
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
                                    return;
                                }
                            }
                            const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                            await sendWhatsappMessage(from, errorMsg);
                            return;
                        }

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
                                    return;
                                } else if (nextStage) {
                                    userStates.set(from, nextStage);
                                    const stageRowNew = botFlowData.find(row => row[0] === nextStage);
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
                                    return;
                                } else {
                                    const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                                    await sendWhatsappMessage(from, errorMsg);
                                    return;
                                }
                            } else {
                                const errorMsg = 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow);
                                await sendWhatsappMessage(from, errorMsg);
                            }
                        }
                    });
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

loadBotFlowData().then(() => {
    app.listen(PORT, () => {
        console.log(`[Server] Server is listening on port ${PORT}`);
    });
}).catch(err => {
    console.error('[Startup][Sheet][ERROR]', err);
});*/
