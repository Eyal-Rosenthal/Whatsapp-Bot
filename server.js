console.log('Starting server.js: loading required modules...');

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const xlsx = require('xlsx');

console.log('Required modules loaded successfully');

const app = express();
app.use(bodyParser.json());

const {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PORT = 8080,
    WHATSAPP_PHONE,
} = process.env;

// --- Load Sheet Locally (xlsx for flexibility) ---
function loadSheetData() {
    const filePath = path.join(__dirname, 'Whatsapp-bot.xlsx');
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {header:1});
    return rawRows;
}

// --- User State ---
const userStates = new Map();

// --- Option Extraction: Flexible!! ---
function getOptions(row) {
    let options = [];
    for (let i = 2; i < row.length; i += 2) {
        // מזהה שלב הבא תקין (לא ריק/undefined)
        if (row[i + 1] !== undefined && row[i + 1] !== null && row[i + 1].toString().trim() !== '') {
            options.push({ text: row[i] ? row[i].toString().trim() : '', next: row[i + 1].toString().trim() });
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

// --- Webhook Verification ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// --- WhatsApp Webhook Handler ---
app.post('/webhook', async (req, res) => {
    try {
        const entryArray = req.body.entry;
        if (!entryArray || entryArray.length === 0) return res.sendStatus(200);
        const changes = entryArray[0].changes;
        if (!changes || changes.length === 0) return res.sendStatus(200);
        const value = changes[0].value;
        if (!value || !value.messages || value.messages.length === 0) return res.sendStatus(200);
        const message = value.messages[0];

        if (!message.text || !message.text.body || !message.text.body.trim()) {
            console.log('[DEBUG] התקבלה פנייה ללא טקסט אמיתי, מתעלם');
            return res.sendStatus(200);
        }

        const from = message.from;
        const userInput = message.text.body.trim();
        const sheetData = loadSheetData();

        let currentStage = userStates.get(from) || '0';
        let stageRow = sheetData.find(row => row[0].toString().trim() === currentStage);

        if (!stageRow) {
            console.log(`[DEBUG] שלב לא נמצא בגיליון - איפוס ל-0. from=${from} currentStage=${currentStage}`);
            currentStage = '0';
            stageRow = sheetData.find(row => row[0].toString().trim() === currentStage);
        }

        console.log(`[LOG][USER] from=${from} input='${userInput}' currentStage=${currentStage}`);
        console.log(`[DEBUG] stageRow: ${JSON.stringify(stageRow)}`);

        // מעבר שלבים בפועל רק אם יש קלט מתאים
        if (userInput && currentStage !== '0') {
            const options = getOptions(stageRow);
            const selectedOption = parseInt(userInput, 10);
            console.log(`[DEBUG] קלט מהמשתמש: '${userInput}', selectedOption=${selectedOption}, optionsCount=${options.length}, options=${JSON.stringify(options)}`);
            if (!isNaN(selectedOption) && selectedOption >= 1 && selectedOption <= options.length) {
                const nextStage = options[selectedOption - 1].next;
                console.log(`[DEBUG] nextStage שמתקבל: '${nextStage}'`);
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
                    currentStage = nextStage;
                    userStates.set(from, currentStage);
                    stageRow = sheetData.find(row => row[0].toString().trim() === currentStage);
                    if (!stageRow) {
                        console.log(`[ERROR] שלב הבא ${currentStage} לא נמצא בגיליון`);
                        await axios.post(
                            `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE}/messages`,
                            {
                                messaging_product: 'whatsapp',
                                to: from,
                                text: { body: 'שגיאת מערכת: שלב לא נמצא.' }
                            },
                            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
                        );
                        return res.sendStatus(200);
                    }
                    const responseMessage = composeMessage(stageRow);
                    console.log(`[SEND] מעביר משתמש ${from} לשלב ${currentStage}: ${responseMessage}`);
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
                } else {
                    const errorMsg = 'בחרת אפשרות שאינה קיימת, נסה שוב:\n' + composeMessage(stageRow);
                    console.log(`[WARN] אפשרות חוקית אך מזהה שלב הבא ריק: from=${from}, input=${userInput}, options=${JSON.stringify(options)}`);
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
                const errorMsg = 'בחרת אפשרות לא חוקית, נסה שוב:\n' + composeMessage(stageRow);
                console.log(`[WARN] קלט לא חוקי: from=${from}, input=${userInput}, options=${JSON.stringify(options)}`);
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

        // שליחה ראשונית
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
