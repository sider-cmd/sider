// =================【2. LINE Webhook 路由】=================
app.post('/callback', line.middleware(config), async (req, res) => {
  // 💡 安全機制 1：如果 LINE 傳送空事件（核實機制），直接回覆 200 OK 應付它
  if (!req.body.events || req.body.events.length === 0) {
    return res.status(200).send('OK');
  }

  try {
    const result = await Promise.all(req.body.events.map(handleEvent));
    res.json(result);
  } catch (err) {
    console.error('Webhook 內部處理錯誤:', err);
    // 💡 安全機制 2：就算出錯也先給 LINE 200，避免 LINE 系統判定斷線
    res.status(200).send('Error but handled'); 
  }
});
