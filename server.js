const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const lastActivity = new Map();
const pauseAwaitingResponse = new Map();

/////////////////////////////////////////
// מיפוי שלבים -> שדות גיליון
const stageToFieldMap = {
    '0': 'סיבת הפנייה',
    '1': 'מועצה אזורית',
    '2': 'יישוב',
    '3': 'יישוב',
    '4': 'שם פרטי',
    '5': 'שם משפחה',
    '6': 'טלפון נייד',
    '7': 'כתובת מייל'
};
/////////////////////////////////////////

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
    Google_Response_Sheet,
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
        .filter(row => row[0] && String(row[0]).trim() && String(row[0]).toLowerCase() !== 'stage');
    fs.writeFileSync(BOTFLOW_JSON, JSON.stringify(botFlowData, null, 2), 'utf8');
    console.log('[Loaded] Bot flow loaded into RAM and botflow.json');
}

// פונקציית עזר לשמירת תשובה עדכנית
const updateUserAnswer = (from, stage, userInput) => {
    const field = stageToFieldMap[stage];
    if (field) {
        if (!userAnswers.has(from)) userAnswers.set(from, {});
        userAnswers.get(from)[field] = userInput;
    }
};

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
    if (row.length === 4 && /^\[.*\]$/.test(row[2]?.trim?.())) return row[1];
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i] && !/^\[.*\]$/.test(row[i])) msg += `${count} - ${row[i]}\n`;
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
                        lastActivity.set(from, Date.now());

                        // HANDLE PAUSE RESPONSE LOGIC
                        if (pauseAwaitingResponse.has(from)) {
                            const pauseInfo = pauseAwaitingResponse.get(from);
                            if (userInput === "1") {
                                userStates.set(from, pauseInfo.prevStage);
                                pauseAwaitingResponse.delete(from);
                                const prevRow = botFlowData.find(row => String(row[0]).trim() === String(pauseInfo.prevStage).trim());
                                if (prevRow) await sendWhatsappMessage(from, composeMessage(prevRow));
                                return;
                            }
                            if (userInput === "2") {
                                pauseAwaitingResponse.delete(from);
                                userStates.delete(from);
                                endedSessions.delete(from);
                                mustSendIntro.delete(from);
                                const endRow = botFlowData.find(row => String(row[0]).trim() === String(pauseInfo.endStage).trim());
                                if (endRow) await sendWhatsappMessage(from, endRow[1]);
                                userAnswers.delete(from);
                                return;
                            }
                            const pauseRow = botFlowData.find(row => String(row[0]).trim() === "End Session after pause");
                            if (pauseRow) {
                                const pauseMsg = `${pauseRow[2]}\n1 - כן\n2 - לא`;
                                await sendWhatsappMessage(from, pauseMsg);
                            }
                            return;
                        }

                        let currentStage = userStates.get(from);

                        // סשן חדש
                        if (!currentStage) {
                            userStates.set(from, '0');
                            let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                            if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                            return;
                        }

                        let stageRow = botFlowData.find(row => String(row[0]).trim() === String(currentStage).trim());

                        // שלב סיום
                        if (stageRow && stageRow.length === 2) {
                            if (String(stageRow[0]).trim() === '9') {
                                await appendSessionToSheet(userAnswers.get(from));
                            }
                            userStates.delete(from);
                            endedSessions.delete(from);
                            mustSendIntro.delete(from);
                            userAnswers.delete(from);
                            await sendWhatsappMessage(from, stageRow[1]);
                            return;
                        }

                        // שלב קלט חופשי
                        if (
                            stageRow &&
                            stageRow.length >= 3 &&
                            /^\[.*\]$/.test(stageRow[2]?.trim?.()) &&
                            !String(currentStage).endsWith('_AWAITING_TEXT')
                        ) {
                            await sendWhatsappMessage(from, stageRow[1]);
                            userStates.set(from, String(stageRow[0]).trim() + '_AWAITING_TEXT');
                            return;
                        }

                        // טיפול ב-AWAITING_TEXT
                        if (String(currentStage).endsWith('_AWAITING_TEXT')) {
                            const baseStage = currentStage.replace('_AWAITING_TEXT', '');
                            updateUserAnswer(from, baseStage, userInput);
                            const stageRowBase = botFlowData.find(row => String(row[0]).trim() === baseStage);

                            const nextStage = stageRowBase[3];
                            if (nextStage) {
                                let nextRow = botFlowData.find(row => String(row[0]).trim() === String(nextStage).trim());
                                if (nextRow && nextRow.length === 2) {
                                    if (String(nextRow[0]).trim() === '9') {
                                        await appendSessionToSheet(userAnswers.get(from));
                                    }
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    userAnswers.delete(from);
                                    await sendWhatsappMessage(from, nextRow[1]);
                                    return;
                                }
                                if (nextRow && nextRow.length >= 3 && /^\[.*\]$/.test(nextRow[2]?.trim?.())) {
                                    await sendWhatsappMessage(from, nextRow[1]);
                                    userStates.set(from, String(nextStage).trim() + '_AWAITING_TEXT');
                                    return;
                                }
                                if (nextRow) {
                                    await sendWhatsappMessage(from, composeMessage(nextRow));
                                    userStates.set(from, String(nextStage).trim());
                                    return;
                                }
                                userStates.delete(from);
                                endedSessions.delete(from);
                                mustSendIntro.delete(from);
                                let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                                if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                                userAnswers.delete(from);
                                return;
                            }
                            userStates.delete(from);
                            endedSessions.delete(from);
                            mustSendIntro.delete(from);
                            userAnswers.delete(from);
                            return;
                        }

                        // שלב בחירה מרובה
                        if (stageRow) {
                            const selectedOption = parseInt(userInput, 10);
                            const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                                updateUserAnswer(from, currentStage, selectedOption);
                                const nextStageColIndex = 2 * selectedOption + 1;
                                const nextStage = stageRow[nextStageColIndex];
                                if (nextStage && String(nextStage).toLowerCase() === 'final') {
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    userAnswers.delete(from);
                                    await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                    return;
                                } else if (nextStage) {
                                    let nextRow = botFlowData.find(row => String(row[0]).trim() === String(nextStage).trim());
                                    if (nextRow && nextRow.length === 2) {
                                        if (String(nextRow[0]).trim() === '9') {
                                            await appendSessionToSheet(userAnswers.get(from));
                                        }
                                        userStates.delete(from);
                                        endedSessions.delete(from);
                                        mustSendIntro.delete(from);
                                        userAnswers.delete(from);
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        return;
                                    }
                                    if (nextRow && nextRow.length >= 3 && /^\[.*\]$/.test(nextRow[2]?.trim?.())) {
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        userStates.set(from, String(nextStage).trim() + '_AWAITING_TEXT');
                                        return;
                                    }
                                    if (nextRow) {
                                        await sendWhatsappMessage(from, composeMessage(nextRow));
                                        userStates.set(from, String(nextStage).trim());
                                        return;
                                    }
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                                    if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                                    userAnswers.delete(from);
                                    return;
                                }
                            }
                        }
                        // הודעת שגיאה
                        if (stageRow && userStates.has(from)) {
                            await sendWhatsappMessage(from, 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow));
                        }
                    }); // סוף enqueueUserTask
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook][POST][ERROR]', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

///////////////////////////////////////////////////////////////

// עדכון Pause מתוזמן
setInterval(async () => {
    const now = Date.now();
    const pauseRow = botFlowData.find(row => String(row[0]).trim() === "End Session after pause");
    let pauseReminderMinutes = 5;
    if (pauseRow && pauseRow[1] && !isNaN(Number(pauseRow[1]))) {
        pauseReminderMinutes = Number(pauseRow[1]);
    }
    const pauseReminderMs = pauseReminderMinutes * 60 * 1000;

    // שליחת הודעת Pause
    for (const [from, time] of lastActivity.entries()) {
        if (userStates.has(from) && !pauseAwaitingResponse.has(from) && now - time > pauseReminderMs) {
            if (pauseRow) {
                const pauseMsg = `${pauseRow[2]}\n1 - כן\n2 - לא`;
                await sendWhatsappMessage(from, pauseMsg);
                pauseAwaitingResponse.set(from, {
                    prevStage: userStates.get(from),
                    endStage: pauseRow[3],
                    sentAt: Date.now()
                });
            }
        }
        if (!userStates.has(from)) {
            lastActivity.delete(from);
            pauseAwaitingResponse.delete(from);
        }
    }
    // טיפול בלא עונים ל-pause
    for (const [from, pauseData] of pauseAwaitingResponse.entries()) {
        if (Date.now() - pauseData.sentAt > pauseReminderMs) {
            const endRow = botFlowData.find(row => String(row[0]).trim() === String(pauseData.endStage).trim());
            if (endRow) {
                await sendWhatsappMessage(from, endRow[1]);
            }
            userStates.delete(from);
            endedSessions.delete(from);
            mustSendIntro.delete(from);
            userAnswers.delete(from);
            pauseAwaitingResponse.delete(from);
            lastActivity.delete(from);
        }
    }
}, 60 * 1000);

///////////////////////////////////////////////////////////////

// שמך במשתנה סביבה (env): Google_Response_Sheet
const GOOGLE_RESPONSES_SHEET_ID = Google_Response_Sheet;

async function appendSessionToSheet(sessionAnswers) {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    // שלוף את הכותרות מהגיליון
    const sheetInfo = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_RESPONSES_SHEET_ID,
        range: 'Sheet1!1:1'
    });
    const headers = sheetInfo.data.values[0];

    // הכנת שורה חדשה כולל המרת מספר למלל בבחירה מרובה
    const values = await Promise.all(headers.map(async colName => {
        if (colName === 'מועד פנייה') return new Date().toLocaleString('he-IL');
        let inputVal = (sessionAnswers && sessionAnswers[colName]) || '';
        if (inputVal && !isNaN(inputVal)) {
            const row = botFlowData.find(row => row.some(cell => (cell || '').trim() === colName.trim()));
            if (row && row.length >= 4) {
                let count = 1;
                for (let i = 2; i < row.length; i += 2, count++) {
                    if (count == inputVal && row[i]) {
                        inputVal = row[i];
                        break;
                    }
                }
            }
        }
        return inputVal;
    }));

    // כתיבה לשורה חדשה בגיליון
    await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_RESPONSES_SHEET_ID,
        range: 'Sheet1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [values] }
    });
}

///////////////////////////////////////////////////////////////

loadBotFlowData().then(() => {
    app.listen(PORT, () => {
        console.log(`[Server] Server is listening on port ${PORT}`);
    });
}).catch(err => {
    console.error('[Startup][Sheet][ERROR]', err);
});






//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/*const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const lastActivity = new Map();
const pauseAwaitingResponse = new Map(); // שמירת סטייט pause למשתמשים

///////////////////////////////////////////////////////////////
const stageToFieldMap = {
    '0': 'סיבת הפנייה',
    '1': 'מועצה אזורית',
    '2': 'יישוב',
    '3': 'יישוב', // אם יש מסלול חלופי או חזרה
    '4': 'שם פרטי',
    '5': 'שם משפחה',
    '6': 'טלפון נייד',
    '7': 'כתובת מייל'
    // 'מועד פנייה' נגזר אוטומטית בסוף
};
////////////////////////////////////////////////////////////////


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
    Google_Response_Sheet,
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
    // אם יש placeholder אחד בלבד אחרי הכותרת — זה שלב קלט חופשי
    if (row.length === 4 && /^\[.*\]$/.test(row[2]?.trim?.())) return row[1];
    // מקרים רגילים
    let msg = row[1] + '\n';
    for (let i = 2, count = 1; i < row.length; i += 2, count++) {
        if (row[i] && !/^\[.*\]$/.test(row[i])) msg += `${count} - ${row[i]}\n`;
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

                            lastActivity.set(from, Date.now());

                            if (pauseAwaitingResponse.has(from)) {
                                const pauseInfo = pauseAwaitingResponse.get(from);
                                if (userInput === "1") {
                                    // המשתמש רוצה להמשיך – מחזיר אותו לשלב שבו היה
                                    userStates.set(from, pauseInfo.prevStage);
                                    pauseAwaitingResponse.delete(from);
                                    // הצג שוב את ההודעה של השלב בו היה
                                    const prevRow = botFlowData.find(row => String(row[0]).trim() === String(pauseInfo.prevStage).trim());
                                    if (prevRow) await sendWhatsappMessage(from, composeMessage(prevRow));
                                    return;
                                }
                                if (userInput === "2") {
                                    // המשתמש רוצה לסיים – מעביר לשלב סיום לפי ה־pauseRow
                                    pauseAwaitingResponse.delete(from);
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    const endRow = botFlowData.find(row => String(row[0]).trim() === String(pauseInfo.endStage).trim());
                                    if (endRow) await sendWhatsappMessage(from, endRow[1]);
                                    return;
                                }
                                // אם קלט לא מזוהה, אפשר להחזיר שוב את אותה ההודעה עם אפשרויות
                                const pauseRow = botFlowData.find(row => String(row[0]).trim() === "End Session after pause");
                                if (pauseRow) {
                                    const pauseMsg = `${pauseRow[2]}\n1 - כן\n2 - לא`;
                                    await sendWhatsappMessage(from, pauseMsg);
                                }
                                return;
                            }
                            
                            let currentStage = userStates.get(from);

                            // התחלה מחדש אם אין סטייט
                            if (!currentStage) {
                                userStates.set(from, '0');
                                let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                                if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                                return;
                            }

                            let stageRow = botFlowData.find(row => String(row[0]).trim() === String(currentStage).trim());

                            // שלב סיום - שורה עם שתי עמודות בלבד
                            if (stageRow && stageRow.length === 2) {
                                if (nextRow && nextRow.length === 2 && String(nextRow[0]).trim() === '9') {
                                    // שלח רק נתונים רלוונטיים, ממפה מספרי בחירה למלל לפי הצורך
                                    await appendSessionToSheet(userAnswers.get(from));
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    userAnswers.delete(from);
                                    await sendWhatsappMessage(from, nextRow[1]);
                                    return;
                                }
                                userStates.delete(from);
                                endedSessions.delete(from);
                                mustSendIntro.delete(from);
                                await sendWhatsappMessage(from, stageRow[1]);
                                return;
                            }

                            // שלב קלט טקסט חופשי (לא ב־AWAITING_TEXT)
                            if (
                                stageRow &&
                                stageRow.length >= 3 &&
                                /^\[.*\]$/.test(stageRow[2]?.trim?.()) &&
                                !String(currentStage).endsWith('_AWAITING_TEXT')
                            ) {
                                await sendWhatsappMessage(from, stageRow[1]);
                                userStates.set(from, String(stageRow[0]).trim() + '_AWAITING_TEXT');
                                return;
                            }

                            // טיפול ב־AWAITING_TEXT (צריך להמשיך רק אם nextStage באמת קיים!)
                            if (String(currentStage).endsWith('_AWAITING_TEXT')) {
                                const baseStage = currentStage.replace('_AWAITING_TEXT', '');
                                const stageRowBase = botFlowData.find(row => String(row[0]).trim() === baseStage);
                                if (!userAnswers.has(from)) userAnswers.set(from, {});
                                const fieldName = (stageRowBase[2] || '').replace(/[\[\]]/g, '').trim();
                                userAnswers.get(from)[fieldName] = userInput;
                                const nextStage = stageRowBase[3];
                                if (nextStage) {
                                    let nextRow = botFlowData.find(row => String(row[0]).trim() === String(nextStage).trim());
                                    if (nextRow && nextRow.length === 2) {
                                        if (nextRow && nextRow.length === 2 && String(nextRow[0]).trim() === '9') {
                                            // שלח רק נתונים רלוונטיים, ממפה מספרי בחירה למלל לפי הצורך
                                            await appendSessionToSheet(userAnswers.get(from));
                                            userStates.delete(from);
                                            endedSessions.delete(from);
                                            mustSendIntro.delete(from);
                                            userAnswers.delete(from);
                                            await sendWhatsappMessage(from, nextRow[1]);
                                            return;
                                        }
                                        // שלב סיום אמיתי
                                        userStates.delete(from);
                                        endedSessions.delete(from);
                                        mustSendIntro.delete(from);
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        return;
                                    }
                                    if (nextRow && nextRow.length >= 3 && /^\[.*\]$/.test(nextRow[2]?.trim?.())) {
                                        // מעביר לשלב טקסט חופשי נוסף
                                        await sendWhatsappMessage(from, nextRow[1]);
                                        userStates.set(from, String(nextStage).trim() + '_AWAITING_TEXT');
                                        return;
                                    }
                                    if (nextRow) {
                                        // שלב רגיל
                                        await sendWhatsappMessage(from, composeMessage(nextRow));
                                        userStates.set(from, String(nextStage).trim());
                                        return;
                                    }
                                    // nextStage לא מזוהה: שגיאה, איפוס סשן ופתיחה מחדש
                                    userStates.delete(from);
                                    endedSessions.delete(from);
                                    mustSendIntro.delete(from);
                                    let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                                    if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                                    return;
                                }
                                // nextStage ריק: סשן הסתיים (בעיה בגיליון?) — לא עושים כלום.
                                userStates.delete(from);
                                endedSessions.delete(from);
                                mustSendIntro.delete(from);
                                return;
                            }

                            // שלב בחירה מרובה
                            if (stageRow) {
                                const selectedOption = parseInt(userInput, 10);
                                const validOptionsCount = Math.floor((stageRow.length - 2) / 2);
                                if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= validOptionsCount) {
                                    const nextStageColIndex = 2 * selectedOption + 1;
                                    const nextStage = stageRow[nextStageColIndex];
                                    if (nextStage && String(nextStage).toLowerCase() === 'final') {
                                        userStates.delete(from);
                                        endedSessions.delete(from);
                                        mustSendIntro.delete(from);
                                        await sendWhatsappMessage(from, 'תודה שיצרת קשר!');
                                        return;
                                    } else if (nextStage) {
                                        let nextRow = botFlowData.find(row => String(row[0]).trim() === String(nextStage).trim());
                                        if (nextRow && nextRow.length === 2) {
                                            if (nextRow && nextRow.length === 2 && String(nextRow[0]).trim() === '9') {
                                            // שלח רק נתונים רלוונטיים, ממפה מספרי בחירה למלל לפי הצורך
                                            await appendSessionToSheet(userAnswers.get(from));
                                            userStates.delete(from);
                                            endedSessions.delete(from);
                                            mustSendIntro.delete(from);
                                            userAnswers.delete(from);
                                            await sendWhatsappMessage(from, nextRow[1]);
                                            return;
                                        }                                            
                                            userStates.delete(from);
                                            endedSessions.delete(from);
                                            mustSendIntro.delete(from);
                                            await sendWhatsappMessage(from, nextRow[1]);
                                            return;
                                        }
                                        if (nextRow && nextRow.length >= 3 && /^\[.*\]$/.test(nextRow[2]?.trim?.())) {
                                            await sendWhatsappMessage(from, nextRow[1]);
                                            userStates.set(from, String(nextStage).trim() + '_AWAITING_TEXT');
                                            return;
                                        }
                                        if (nextRow) {
                                            await sendWhatsappMessage(from, composeMessage(nextRow));
                                            userStates.set(from, String(nextStage).trim());
                                            return;
                                        }
                                        // nextRow undefined
                                        userStates.delete(from);
                                        endedSessions.delete(from);
                                        mustSendIntro.delete(from);
                                        let startRow = botFlowData.find(row => String(row[0]).trim() === '0');
                                        if (startRow) await sendWhatsappMessage(from, composeMessage(startRow));
                                        return;
                                    }
                                }
                            }

                            // שליחת שגיאה — רק אם stageRow קיים וסטייט בתוקף
                            if (stageRow && userStates.has(from)) {
                                await sendWhatsappMessage(from, 'בחרת אפשרות שאינה קיימת, אנא בחר שוב\n' + composeMessage(stageRow));
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




// לולאת בדיקה פעם בדקה
setInterval(async () => {
    const now = Date.now();

    // משוך ערך זמן ההמתנה מהשורה הרלוונטית בגוגל שיט
    const pauseRow = botFlowData.find(row => String(row[0]).trim() === "End Session after pause");
    let pauseReminderMinutes = 5; // ברירת מחדל ל-5 דקות
    if (pauseRow && pauseRow[1] && !isNaN(Number(pauseRow[1]))) {
        pauseReminderMinutes = Number(pauseRow[1]);
    }
    const pauseReminderMs = pauseReminderMinutes * 60 * 1000;

    // סרוק כל הפעילויות האחרונות
    for (const [from, time] of lastActivity.entries()) {
        // חלף הזמן ואין הודעת pause
        if (
            userStates.has(from) &&
            !pauseAwaitingResponse.has(from) &&
            now - time > pauseReminderMs
        ) {
            // שלח הודעת pause
            if (pauseRow) {
                const pauseMsg = `${pauseRow[2]}\n1 - כן\n2 - לא`;
                await sendWhatsappMessage(from, pauseMsg);
                pauseAwaitingResponse.set(from, {
                    prevStage: userStates.get(from),
                    endStage: pauseRow[3],
                    sentAt: Date.now()
                });
            }
        }
        if (!userStates.has(from)) {
            lastActivity.delete(from);
            pauseAwaitingResponse.delete(from);
        }
    }

    // סרוק משתמשים שממתינים לתשובה ל-pause
    for (const [from, pauseData] of pauseAwaitingResponse.entries()) {
        if (Date.now() - pauseData.sentAt > pauseReminderMs) {
            // עבר זמן — דמה "לחיצה על 2" וסיים את הסשן
            const endRow = botFlowData.find(row => String(row[0]).trim() === String(pauseData.endStage).trim());
            if (endRow) {
                await sendWhatsappMessage(from, endRow[1]);
            }
            userStates.delete(from);
            endedSessions.delete(from);
            mustSendIntro.delete(from);
            pauseAwaitingResponse.delete(from);
            lastActivity.delete(from);
        }
    }
}, 10 * 1000); // רץ כל דקה


/////////////////////////////////////////////////////////////////////////////////////////////////////

// שמך במשתנה סביבה (env): Google_Response_Sheet
const GOOGLE_RESPONSES_SHEET_ID = Google_Response_Sheet;

// סדר ושמות העמודות (ניתן להרחיב רק מצידו של הגיליון)
const RESPONSE_COLUMNS = [
    'מועד פנייה',    // נבנה אוטומטית בקוד
    'שם פרטי',
    'שם משפחה',
    'טלפון נייד',
    'כתובת מייל',
    'יישוב',
    'מועצה',
    'סיבת הפנייה'
];

// פונקציה שממפה נתוני session לשורת ערכים עבור המערכת
async function appendSessionToSheet(sessionAnswers) {
    const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    // שלוף כותרות העמודות מהגיליון
    const sheetInfo = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_RESPONSES_SHEET_ID,
        range: 'Sheet1!1:1'
    });
    const headers = sheetInfo.data.values[0];

    // לולאה להכנת שורה — כולל המרת בחירה מרובה מילולית
    const values = await Promise.all(headers.map(async colName => {
        if (colName === 'מועד פנייה') return new Date().toLocaleString('he-IL');

        // -- כאן מזהה אם צריך לבצע המרת בחירה מרובה --
        let inputVal = (sessionAnswers && sessionAnswers[colName]) || '';
        if (inputVal && !isNaN(inputVal)) {
            // אם זה ערך מספרי, נסה להמיר אותו לאופציה המילולית מגיליון הבוט
            // חפש שלב שהכותרת שלו תואמת לשם העמודה (אפשר גם ע"י מילון mapping פשוט)
            const row = botFlowData.find(
                row => row.some(cell => (cell || '').trim() === colName.trim())
            );
            if (row && row.length >= 4) {
                // אתרי אופציות (בהנחה שמתחיל מטור 2)
                let count = 1;
                for (let i = 2; i < row.length; i += 2, count++) {
                    if (count == inputVal && row[i]) {
                        inputVal = row[i];
                        break;
                    }
                }
            }
        }
        return inputVal;
    }));

    // שלח השורה החדשה
    await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_RESPONSES_SHEET_ID,
        range: 'Sheet1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [values] }
    });
}





/////////////////////////////////////////////////////////////////////////////////////////////////////



loadBotFlowData().then(() => {
    app.listen(PORT, () => {
        console.log(`[Server] Server is listening on port ${PORT}`);
    });
}).catch(err => {
    console.error('[Startup][Sheet][ERROR]', err);
});*/

