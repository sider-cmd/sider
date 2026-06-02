const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
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
let stockId = userMessage.trim(); 
const stockNames = {
"2330": "台積電",
"2317": "鴻海",
"2454": "聯發科",
"2303": "聯電",
"2603": "長榮",
"2609": "陽明",
"2615": "萬海",
"2881": "富邦金",
"2882": "國泰金",
"2891": "中信金",
"2886": "兆豐金",
"2884": "玉山金",
"2885": "元大金",
"2892": "第一金",
"5880": "合庫金",
"1301": "台塑",
"1303": "南亞",
"1326": "台化",
"2002": "中鋼",
"1216": "統一",
"2207": "和泰車",
"2308": "台達電",
"2357": "華碩",
"2379": "瑞昱",
"2382": "廣達",
"2395": "研華",
"2408": "南亞科",
"2409": "友達",
"2412": "中華電",
"2449": "京元電子",
"2451": "創見",
"2474": "可成",
"2606": "裕民",
"2618": "長榮航",
"2634": "漢翔",
"2801": "彰銀",
"2834": "臺企銀",
"2880": "華南金",
"3008": "大立光",
"3034": "聯詠",
"3037": "欣興",
"3045": "台灣大",
"3231": "緯創",
"3443": "創意",
"3481": "群創",
"3711": "日月光投控",
"4904": "遠傳",
"4938": "和碩",
"6505": "台塑化",
"6669": "緯穎",
"8046": "南電",
"8454": "富邦媒",
"9910": "豐泰", 
"0050": "元大台灣50",
"0056": "元大高股息",
"00878": "國泰永續高股息",
"00919": "群益台灣精選高息",
"00929": "復華台灣科技優息",
"1101": "台泥",
"1102": "亞泥",
"1402": "遠東新",
"1476": "儒鴻",
"1504": "東元",
"1590": "亞德客-KY",
"1605": "華新",
"1707": "葡萄王",
"1802": "台玻",
"2014": "中鴻",
"2027": "大成鋼",
"2105": "正新",
"2201": "裕隆",
"2324": "仁寶",
"2327": "國巨",
"2337": "旺宏",
"2344": "華邦電",
"2345": "智邦",
"2347": "聯強",
"2353": "宏碁",
"2356": "英業達",
"2360": "致茂",
"2368": "金像電",
"2376": "技嘉",
"2383": "台光電",
"2404": "漢唐",
"2464": "盟立",
"2472": "立隆電",
"2498": "宏達電",
"3017": "奇鋐",
"3023": "信邦",
"3044": "健鼎",
"3189": "景碩",
"3293": "鈊象",
"3533": "嘉澤",
"3661": "世芯-KY",
"4958": "臻鼎-KY",
"5269": "祥碩",
"5388": "中磊",
"5871": "中租-KY",
"6176": "瑞儀",
"6415": "矽力-KY",
"1519": "華城",
"1524": "耿鼎",
"1536": "和大",
"1560": "中砂",
"1589": "永冠-KY",
"1611": "中電",
"1722": "台肥",
"1785": "光洋科",
"1909": "榮成",
"2049": "上銀",
"2231": "為升",
"2301": "光寶科",
"2328": "廣宇",
"2340": "台亞",
"2348": "海悅",
"2354": "鴻準",
"2367": "燿華",
"2377": "微星",
"2385": "群光",
"2401": "凌陽",
"2421": "建準",
"2428": "興勤",
"2439": "美律",
"2441": "超豐",
"2455": "全新",
"2481": "強茂",
"3013": "晟銘電",
"3019": "亞光",
"3026": "禾伸堂",
"3035": "智原",
"3059": "華晶科",
"3081": "聯亞",
"3211": "順達",
"3376": "新日興",
"3450": "聯鈞",
"3596": "智易",
"3702": "大聯大",
"4763": "材料-KY",
"4919": "新唐",
"4952": "凌通",
"5222": "全訊",
"5347": "世界",
"5439": "高技",
"5483": "中美晶",
"6121": "新普",
"6187": "萬潤",
"6202": "盛群",
"6239": "力成",
"6274": "台燿",
"8150": "南茂"
};
const reverseStockNames = {};

for (const key in stockNames) {
  reverseStockNames[stockNames[key]] = key;
}

const cleanInput = userMessage.trim(); 
let pureCode = cleanInput;

// 如果輸入的是中文（例如台積電），就轉成代號
if (reverseStockNames[cleanInput]) {
  pureCode = reverseStockNames[cleanInput];
}

// 股票名稱
const stockName = stockNames[pureCode] || cleanInput;

// API 專用格式
const apiChannel = `tse_${pureCode}.tw`;

console.log(`[系統日誌] 查詢股票: ${stockName} (${pureCode})`);

const response = await axios.get(
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${apiChannel}`
);

// 取得資料
const stockData = response.data.msgArray?.[0] || {};

// 印出 API 原始資料
console.log(
  "[API 回傳資料]",
  JSON.stringify(response.data, null, 2)
);

// 股價防呆
const stockPrice =
  stockData.z ||
  stockData.pz ||
  stockData.y ||
  "查無市價";
// 1. 智慧判定股價（徹底解決減號與空值問題）
let stockPrice = "查無市價";
if (stockData.z && stockData.z !== "-") {
  stockPrice = stockData.z;
} else if (stockData.pz && stockData.pz !== "-") {
  stockPrice = stockData.pz;
} else if (stockData.y && stockData.y !== "-") {
  stockPrice = stockData.y;
}

// 2. 發送訊息給 LINE
await client.replyMessage(event.replyToken, {
  type: 'text',
  text: `📊 AI股票分析

股票：${stockName}

目前股價：${stockPrice} 元

AI評分：70分
主力訊號：2/3
風險分數：50分

✅ 偏多觀察
建議持股：50%~70%

📌 AI總結：
趨勢偏強，但短線勿追高。`
});
async function getNews(keyword) {
    try {
        // 1. 強制將關鍵字進行網址編碼，避免中文字造成 Yahoo 噴 400 錯誤
        const encodedKeyword = encodeURIComponent(keyword.trim());
        const url = `https://tw.news.yahoo.com/search?p=${encodedKeyword}`;
        
        console.log("正在爬取的網址:", url); // 這行可以在 Log 幫我們對答案

        // 2. 加上完整的 Headers 偽裝成真人在用 Chrome 瀏覽器
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 5000 // 5秒超時設定
        });
        
        // 3. 解析網頁內容
        const $ = cheerio.load(response.data);
        let newsMessage = `🔍 ${keyword} 最新新聞：\n`;
        let count = 0;
        
        // 4. Yahoo 新聞常見的標題 class 是 .Storyli 或 li.item
        // 這裡做雙重保障，只要抓得到 a 標籤就試試看
        $('li.item, .Storyli').each((index, element) => {
            if (count < 3) { // 只取前 3 則
                const title = $(element).find('a').text().trim();
                let link = $(element).find('a').attr('href');
                
                if (title && link) {
                    // 如果網址是相對路徑，自動補上 Yahoo 字頭
                    if (link.startsWith('/')) {
                        link = `https://tw.news.yahoo.com${link}`;
                    }
                    newsMessage += `\n📺 ${title}\n🔗 ${link}\n`;
                    count++;
                }
            }
        });
        
        if (count === 0) {
            return `查無「${keyword}」的相關新聞。`;
        }
        
        return newsMessage;
    } catch (error) {
        // 如果又失敗了，這行會在 Railway Log 裡面印出到底是為什麼 400
        console.error("新聞爬蟲詳細錯誤資訊:", error.message); 
        return "新聞查詢失敗";
    }
}

// ================= 台股查詢功能 =================
if (/^\d{4}$/.test(stockId) || reverseStockNames[userMessage.trim()]) {
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
