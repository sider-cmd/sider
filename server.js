const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');

const app = express();

// =================【1. LINE & OpenAI 設定】=================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FINMIND_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiU2lkZXIiLCJlbWFpbCI6ImxmY2x1MDQxNEBnbWFpbC5jb20iLCJ0b2tlbl92ZXJzaW9uIjowfQ.K_yeruf5xx8yChBUdcpOTSVAak3zNgi81a0zmqYk96A";
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

// LINE 訊息處理核心
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           
  const stockId = userMessage.trim();
const stockNames = {
  "2330": "台積電",
  "2317": "鴻海",
  "2454": "聯發科",
  "2603": "長榮",
  "2303": "聯電",
  "2881": "富邦金",
  "2882": "國泰金",
  "1301": "台塑"
};

const stockName = stockNames[stockId] || "未知股票";
console.log(`收到 LINE 訊息: ${userMessage}`);
// ================= 台股查詢功能 =================
if (/^\d{4}$/.test(stockId)) {
  try {

    const response = await fetch(
     `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${stockId}&start_date=2026-05-29`,
      {
        headers: {
          Authorization: `Bearer ${FINMIND_TOKEN}`
        }
      }
    );

    const data = await response.json();

    const latest = data.data[data.data.length - 1];
const now = new Date().toLocaleString("zh-TW");
const spread = latest.close - latest.open;
const percent = ((spread / latest.open) * 100).toFixed(2);

let trendIcon = "➖";

if (spread > 0) {
  trendIcon = "🔺";
} else if (spread < 0) {
  trendIcon = "🔻";
}
const stockReply = String.raw`
📈 ${stockName}（${stockId}）
🕒 更新時間：${now}
收盤價：${latest.close} 元
漲跌：${spread.toFixed(1)} 元 ${trendIcon}
漲幅：${percent}% ${trendIcon}
開盤價：${latest.open} 元
最高價：${latest.max} 元
最低價：${latest.min} 元
📊 成交股數：
${latest.Trading_Volume}
`;
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: stockReply
    });

  } catch (error) {

    console.error(error);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '股票查詢失敗 😢'
    });

  }

}
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "你是一位專業的台灣股市分析助理。請用專業、客觀、條理清晰且繁體中文（台灣習慣用語，例如：台股、做多、平盤、K線）來回答使用者關於股票、投資、個股分析或市場趨勢的問題。適時加上 Emoji 讓排版更好讀。" 
        },
        { role: "user", content: userMessage }
      ],
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content.trim();

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: aiResponse
    });

  } catch (error) {
    console.error('OpenAI 或 LINE API 發生錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '（機器人思緒打結中...請稍後再試）'
    });
  }
}

// =================【3. 網頁靜態檔案處理】=================
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =================【4. 啟動伺服器】=================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);      
});
