const userStates = new Map(); // מפת זיכרון לזיהוי מצב כל משתמש

app.post('/webhook', async (req, res) => {
  const from = req.body.from; // מזהה מספר הנמען
  const text = req.body.text.body; // טקסט שהמשתמש שלח

  if (!userStates.has(from)) userStates.set(from, '0'); // שלב התחלתי - "0"

  const currentStage = userStates.get(from);
  const sheetData = await getBotFlow();

  // חיפוש השורה המתאימה לשלב הנוכחי
  const stageRow = sheetData.find(row => row[0] === currentStage);

  // מצא את הבחירה לפי ההודעה שהמשתמש שלח (בהנחה שהמשתמש שולח '1' או '2')
  let nextStage = currentStage; 
  if(text === '1') nextStage = stageRow[3];  
  else if(text === '2') nextStage = stageRow[5];

  if(nextStage) userStates.set(from, nextStage);

  // שלח הודעה על פי השלב החדש
  const nextRow = sheetData.find(row => row[0] === nextStage);
  let reply = nextRow[1] + '\n';
  if(nextRow[2]) reply += `1. ${nextRow[2]}\n`;
  if(nextRow[4]) reply += `2. ${nextRow[4]}\n`;

  // שלח הודעה לוואטסאפ
  await sendWhatsAppMessage(from, reply);

  res.sendStatus(200);
});

// פונקציה לשליחת הודעה
async function sendWhatsAppMessage(to, message) {
  await axios.post(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
    text: { body: message }
  }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
}
