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
const watchlists = new Map();
const portfolios = new Map();
const portfolioTrades = new Map();
const portfolioDividends = new Map();
const priceAlerts = new Map();
const quoteCache = new Map();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const hasPortfolioDb = Boolean(SUPABASE_URL && SUPABASE_KEY);

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal"
});

const portfolioApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_positions`;

const tradeApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_trades`;

const dividendApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_dividends`;

const alertApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/price_alerts`;

const parseOptionalMoney = (text, label) => {
  const match = text.match(new RegExp(`${label}\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
};

const estimateBuyFee = (amount) => Math.round(amount * 0.001425);
const estimateSellFee = (amount) => Math.round(amount * 0.001425);
const estimateSellTax = (amount) => Math.round(amount * 0.003);
const ALERT_CHECK_INTERVAL_MS =
  Number(process.env.ALERT_CHECK_INTERVAL_MS) || 10 * 60 * 1000;

const normalizeAlertDirection = (text = "") =>
  text.includes("下") || text.toLowerCase().includes("below") ? "below" : "above";

const alertDirectionLabel = (direction) => (direction === "below" ? "以下" : "以上");

const fetchAlertYahooQuote = async (code, timeoutMs = 2500) => {
  const cacheKey = `alert:${code}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 60 * 1000) {
    return cached.meta;
  }

  for (const suffix of [".TW", ".TWO"]) {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`,
        { timeout: timeoutMs }
      );
      const meta = response.data.chart.result?.[0]?.meta;
      if (meta) {
        quoteCache.set(cacheKey, { meta, fetchedAt: Date.now() });
        return meta;
      }
    } catch {
      // Try the OTC suffix when the listed-market suffix has no result.
    }
  }

  throw new Error("Yahoo 查無股票資料");
};

const getPortfolio = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolios.get(ownerKey) || new Map();
  }

  const response = await axios.get(portfolioApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "code,shares,average_cost"
    }
  });

  return new Map(
    (response.data || []).map((row) => [
      row.code,
      {
        shares: Number(row.shares),
        averageCost: Number(row.average_cost)
      }
    ])
  );
};

const savePortfolioPosition = async (ownerKey, code, position) => {
  if (!hasPortfolioDb) {
    const portfolio = portfolios.get(ownerKey) || new Map();
    portfolio.set(code, position);
    portfolios.set(ownerKey, portfolio);
    return;
  }

  await axios.post(
    `${portfolioApiUrl()}?on_conflict=owner_key,code`,
    {
      owner_key: ownerKey,
      code,
      shares: position.shares,
      average_cost: position.averageCost
    },
    {
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
    }
  );
};

const deletePortfolioPosition = async (ownerKey, code) => {
  if (!hasPortfolioDb) {
    const portfolio = portfolios.get(ownerKey) || new Map();
    portfolio.delete(code);
    portfolios.set(ownerKey, portfolio);
    return;
  }

  await axios.delete(portfolioApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      code: `eq.${code}`
    }
  });
};

const replacePortfolio = async (ownerKey, portfolio) => {
  if (!hasPortfolioDb) {
    portfolios.set(ownerKey, portfolio);
    return;
  }

  await axios.delete(portfolioApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`
    }
  });

  const rows = [...portfolio.entries()].map(([code, position]) => ({
    owner_key: ownerKey,
    code,
    shares: position.shares,
    average_cost: position.averageCost
  }));

  if (rows.length > 0) {
    await axios.post(portfolioApiUrl(), rows, {
      headers: supabaseHeaders()
    });
  }
};

const recordTrade = async (ownerKey, trade) => {
  if (!hasPortfolioDb) {
    const trades = portfolioTrades.get(ownerKey) || [];
    trades.push({ ...trade, tradedAt: new Date().toISOString() });
    portfolioTrades.set(ownerKey, trades);
    return;
  }

  await axios.post(
    tradeApiUrl(),
    {
      owner_key: ownerKey,
      code: trade.code,
      trade_type: trade.type,
      shares: trade.shares,
      price: trade.price,
      fee: trade.fee || 0,
      tax: trade.tax || 0,
      realized_profit: trade.realizedProfit || 0
    },
    {
      headers: supabaseHeaders()
    }
  );
};

const getTrades = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolioTrades.get(ownerKey) || [];
  }

  const response = await axios.get(tradeApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "code,trade_type,shares,price,fee,tax,realized_profit,traded_at",
      order: "traded_at.desc",
      limit: 20
    }
  });

  return (response.data || []).map((row) => ({
    code: row.code,
    type: row.trade_type,
    shares: Number(row.shares),
    price: Number(row.price),
    fee: Number(row.fee || 0),
    tax: Number(row.tax || 0),
    realizedProfit: Number(row.realized_profit || 0),
    tradedAt: row.traded_at
  }));
};

const getRealizedProfit = async (ownerKey) => {
  if (!hasPortfolioDb) {
    const trades = portfolioTrades.get(ownerKey) || [];
    return trades.reduce((sum, trade) => sum + (trade.realizedProfit || 0), 0);
  }

  const response = await axios.get(tradeApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      trade_type: "eq.sell",
      select: "realized_profit"
    }
  });

  return (response.data || []).reduce(
    (sum, row) => sum + Number(row.realized_profit || 0),
    0
  );
};

const recordDividend = async (ownerKey, dividend) => {
  if (!hasPortfolioDb) {
    const dividends = portfolioDividends.get(ownerKey) || [];
    dividends.push({ ...dividend, receivedAt: new Date().toISOString() });
    portfolioDividends.set(ownerKey, dividends);
    return;
  }

  await axios.post(
    dividendApiUrl(),
    {
      owner_key: ownerKey,
      code: dividend.code,
      amount: dividend.amount,
      note: dividend.note || ""
    },
    {
      headers: supabaseHeaders()
    }
  );
};

const getDividends = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolioDividends.get(ownerKey) || [];
  }

  const response = await axios.get(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "id,code,amount,note,received_at",
      order: "received_at.desc",
      limit: 20
    }
  });

  return (response.data || []).map((row) => ({
    id: row.id,
    code: row.code,
    amount: Number(row.amount),
    note: row.note || "",
    receivedAt: row.received_at
  }));
};

const deleteDividendAt = async (ownerKey, index) => {
  const dividends = await getDividends(ownerKey);
  const dividend = dividends[index - 1];
  if (!dividend) {
    return null;
  }

  if (!hasPortfolioDb) {
    const savedDividends = portfolioDividends.get(ownerKey) || [];
    savedDividends.splice(index - 1, 1);
    portfolioDividends.set(ownerKey, savedDividends);
    return dividend;
  }

  await axios.delete(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      id: `eq.${dividend.id}`
    }
  });

  return dividend;
};

const getDividendTotal = async (ownerKey) => {
  if (!hasPortfolioDb) {
    const dividends = portfolioDividends.get(ownerKey) || [];
    return dividends.reduce((sum, dividend) => sum + Number(dividend.amount || 0), 0);
  }

  const response = await axios.get(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "amount"
    }
  });

  return (response.data || []).reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );
};

const savePriceAlert = async (ownerKey, alert) => {
  if (!hasPortfolioDb) {
    const alerts = priceAlerts.get(ownerKey) || [];
    const nextAlerts = alerts.filter(
      (item) => !(item.code === alert.code && item.direction === alert.direction)
    );
    nextAlerts.push({ ...alert, createdAt: new Date().toISOString() });
    priceAlerts.set(ownerKey, nextAlerts);
    return;
  }

  await axios.post(
    `${alertApiUrl()}?on_conflict=owner_key,code,direction`,
    {
      owner_key: ownerKey,
      code: alert.code,
      direction: alert.direction,
      target_price: alert.targetPrice,
      active: true
    },
    {
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
    }
  );
};

const getPriceAlerts = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return (priceAlerts.get(ownerKey) || []).filter((alert) => alert.active !== false);
  }

  const response = await axios.get(alertApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      active: "eq.true",
      select: "code,direction,target_price,created_at",
      order: "created_at.desc"
    }
  });

  return (response.data || []).map((row) => ({
    code: row.code,
    direction: row.direction,
    targetPrice: Number(row.target_price),
    createdAt: row.created_at
  }));
};

const getAllActivePriceAlerts = async () => {
  if (!hasPortfolioDb) {
    return [...priceAlerts.entries()].flatMap(([ownerKey, alerts]) =>
      alerts
        .filter((alert) => alert.active !== false)
        .map((alert) => ({ ...alert, ownerKey }))
    );
  }

  const response = await axios.get(alertApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      active: "eq.true",
      select: "owner_key,code,direction,target_price,created_at",
      order: "created_at.asc"
    }
  });

  return (response.data || []).map((row) => ({
    ownerKey: row.owner_key,
    code: row.code,
    direction: row.direction,
    targetPrice: Number(row.target_price),
    createdAt: row.created_at
  }));
};

const deactivatePriceAlert = async (ownerKey, code, direction) => {
  if (!hasPortfolioDb) {
    const alerts = priceAlerts.get(ownerKey) || [];
    priceAlerts.set(
      ownerKey,
      alerts.map((alert) =>
        alert.code === code && alert.direction === direction
          ? { ...alert, active: false, lastTriggeredAt: new Date().toISOString() }
          : alert
      )
    );
    return;
  }

  await axios.patch(
    alertApiUrl(),
    {
      active: false,
      last_triggered_at: new Date().toISOString()
    },
    {
      headers: supabaseHeaders(),
      params: {
        owner_key: `eq.${ownerKey}`,
        code: `eq.${code}`,
        direction: `eq.${direction}`
      }
    }
  );
};

const deletePriceAlert = async (ownerKey, code) => {
  if (!hasPortfolioDb) {
    const alerts = priceAlerts.get(ownerKey) || [];
    priceAlerts.set(
      ownerKey,
      alerts.filter((alert) => alert.code !== code)
    );
    return;
  }

  await axios.delete(alertApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      code: `eq.${code}`
    }
  });
};

const checkAndPushPriceAlerts = async () => {
  if (!hasPortfolioDb) {
    console.log("Auto price alerts skipped: database is not enabled");
    return;
  }

  const alerts = await getAllActivePriceAlerts();
  if (alerts.length === 0) {
    return;
  }

  console.log(`Checking ${alerts.length} price alerts`);

  for (const alert of alerts) {
    try {
      const quote = await fetchAlertYahooQuote(alert.code, 2500);
      const price = Number(quote.regularMarketPrice);
      if (!Number.isFinite(price)) {
        continue;
      }

      const triggered =
        alert.direction === "below"
          ? price <= alert.targetPrice
          : price >= alert.targetPrice;

      if (!triggered) {
        continue;
      }

      await client.pushMessage(alert.ownerKey, {
        type: "text",
        text: `🔔 價格提醒到價

股票代號：${alert.code}
現價：${price} 元
條件：${alert.targetPrice} 元 ${alertDirectionLabel(alert.direction)}

此提醒已自動關閉；如需再次提醒，請重新設定。`
      });

      await deactivatePriceAlert(alert.ownerKey, alert.code, alert.direction);
    } catch (error) {
      console.error("自動價格提醒檢查失敗:", {
        ownerKey: alert.ownerKey,
        code: alert.code,
        error: error.message
      });
    }
  }
};

app.get('/audio', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 500);
    if (!text) {
      return res.status(400).send('Missing text');
    }

    const speech = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.type('audio/mpeg').send(buffer);
  } catch (error) {
    console.error('語音產生錯誤:', error.message);
    res.status(500).send('Audio error');
  }
});
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
  const marketInput = userMessage.trim();

  if (marketInput === "指令" || marketInput === "說明") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `📚 AI 股票助理指令

📈 個股：台積電、2330
🤖 技術分析：分析台積電
🏦 法人買賣：法人台積電
📊 融資融券：籌碼台積電
📰 新聞摘要：新聞台積電
📉 K 線圖：K線台積電

⭐ 加入自選：自選+台積電
🗑️ 移除自選：自選-台積電
📋 查看自選：自選股

💼 新增持股：持股+台積電 35 2000
🗑️ 移除持股：持股-台積電
📋 查看持股：我的持股
📥 批次匯入：匯入持股
🧾 買進紀錄：買進 台積電 10 2380
💸 賣出紀錄：賣出 台積電 5 2450
💰 含費用：買進 台積電 10 2380 手續費20
💰 含稅費：賣出 台積電 5 2450 手續費20 交易稅36
🎁 股息股利：股息 台積電 1000
🎁 年度股利：年度股利 2026 3407
🗑️ 刪除股息：股息刪除 5
📜 交易紀錄：交易紀錄
🎁 股息紀錄：股息紀錄
💰 已實現損益：已實現損益

🔔 新增提醒：提醒+台積電 2500 以上
🔔 停損提醒：提醒+台積電 2200 以下
📋 提醒列表：提醒列表
🔎 檢查提醒：檢查提醒
🗑️ 移除提醒：提醒-台積電

🗓️ 今日總結：今日總結
📌 持股日報：持股日報
🌇 盤後總結：盤後總結

🌐 大盤行情：大盤
🧠 大盤分析：分析大盤
🔊 語音播報：語音大盤`
    });
  }

  if (marketInput === "資料庫狀態") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: hasPortfolioDb
        ? "✅ 持股資料庫已啟用，持股可永久保存。"
        : "⚠️ 持股資料庫尚未設定，目前使用記憶體暫存，Railway 重啟後會清空。"
    });
  }

  if (marketInput === "語音大盤") {
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    if (!publicBaseUrl) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "語音播報尚未啟用：請先在 Railway 設定 PUBLIC_BASE_URL。"
      });
    }

    const audioText =
      "台股語音播報。請輸入大盤查看即時加權指數，或輸入分析大盤取得盤勢摘要。";
    return client.replyMessage(event.replyToken, {
      type: "audio",
      originalContentUrl: `${publicBaseUrl.replace(/\/$/, "")}/audio?text=${encodeURIComponent(audioText)}`,
      duration: 9000
    });
  }

  if (marketInput === "大盤" || marketInput === "分析大盤") {
    try {
      const marketRes = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=1mo&interval=1d"
      );

      const marketResult = marketRes.data.chart.result?.[0];
      const marketMeta = marketResult?.meta;
      if (!marketMeta) {
        throw new Error("Yahoo 查無大盤資料");
      }

      const marketPrice = marketMeta.regularMarketPrice;
      const marketPreviousClose =
        marketMeta.previousClose ?? marketMeta.chartPreviousClose;
      const marketOpen =
        marketMeta.regularMarketOpen ?? marketPreviousClose ?? "暫無資料";
      const marketHigh = marketMeta.regularMarketDayHigh ?? "暫無資料";
      const marketLow = marketMeta.regularMarketDayLow ?? "暫無資料";
      const marketChange = (marketPrice - marketPreviousClose).toFixed(2);
      const marketPercent = (
        ((marketPrice - marketPreviousClose) / marketPreviousClose) *
        100
      ).toFixed(2);

      const marketCloses = (marketResult.indicators?.quote?.[0]?.close || [])
        .map(Number)
        .filter(Number.isFinite)
        .slice(-5);
      const marketMa5 =
        marketCloses.length === 5
          ? (
              marketCloses.reduce((sum, value) => sum + value, 0) / 5
            ).toFixed(2)
          : "資料不足";

      if (marketInput === "分析大盤") {
        const marketPrompt = `請根據以下真實行情，提供簡潔的繁體中文台股大盤分析。
不要使用 Markdown 符號，不要保證獲利，結尾提醒投資人自行評估風險。

加權指數：${marketPrice}
漲跌：${marketChange}
漲幅：${marketPercent}%
五日均線：${marketMa5}
今日開盤：${marketOpen}
今日最高：${marketHigh}
今日最低：${marketLow}

請依序說明：
1. 今日盤勢
2. 指數與五日均線關係
3. 短線觀察重點
4. 風險提醒`;

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "你是台股大盤分析助理。只能根據提供的行情分析，使用繁體中文，內容精簡易讀。"
            },
            {
              role: "user",
              content: marketPrompt
            }
          ],
          max_tokens: 500
        });

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: completion.choices[0].message.content.trim()
        });
      }

      const marketTrend =
        Number(marketChange) > 0
          ? "📈"
          : Number(marketChange) < 0
          ? "📉"
          : "➖";
      const now = new Date().toLocaleString("zh-TW");
      const marketReply = `📊 台灣加權指數
🕒 更新時間：${now}
💰 指數：${marketPrice}
📈 漲跌：${marketChange} ${marketTrend}
📊 漲幅：${marketPercent}% ${marketTrend}
📉 五日均線：${marketMa5}

🔓 開盤：${marketOpen}
⬆️ 最高：${marketHigh}
⬇️ 最低：${marketLow}`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: marketReply
      });
    } catch (error) {
      console.error("大盤查詢錯誤:", error.message);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "大盤查詢失敗 😢"
      });
    }
  }

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
"2812": "台中銀",
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
"1513": "中興電",
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
"3455": "由田",
"3596": "智易",
"3680": "家登",
"3702": "大聯大",
"4132": "國鼎",
"4763": "材料-KY",
"4919": "新唐",
"4952": "凌通",
"5222": "全訊",
"5347": "世界",
"5439": "高技",
"5483": "中美晶",
"6121": "新普",
"6125": "廣運",
"6187": "萬潤",
"6202": "盛群",
"6239": "力成",
"6274": "台燿",
"6531": "愛普*",
"8150": "南茂"
};
const reverseStockNames = {};

for (const key in stockNames) {
  reverseStockNames[stockNames[key]] = key;
}

const watchlistKey =
  event.source?.userId ||
  event.source?.groupId ||
  event.source?.roomId ||
  "default";

const resolveStockCode = (input) => {
  const normalized = input.trim();
  return reverseStockNames[normalized] || normalized;
};

const fetchYahooQuote = async (code, timeoutMs = 5000) => {
  const cached = quoteCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < 60 * 1000) {
    return cached.meta;
  }

  for (const suffix of [".TW", ".TWO"]) {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`,
        { timeout: timeoutMs }
      );
      const meta = response.data.chart.result?.[0]?.meta;
      if (meta) {
        quoteCache.set(code, { meta, fetchedAt: Date.now() });
        return meta;
      }
    } catch {
      // Try the OTC suffix when the listed-market suffix has no result.
    }
  }
  throw new Error("Yahoo 查無股票資料");
};

const getPortfolioSnapshots = async (entries, options = {}) => {
  const timeoutMs = options.timeoutMs || 2500;
  const raceMs = options.raceMs || 3500;

  return Promise.all(
    entries.map(async ([code, position]) =>
      Promise.race([
        (async () => {
          try {
            const quote = await fetchYahooQuote(code, timeoutMs);
            const price = Number(quote.regularMarketPrice);
            if (!Number.isFinite(price)) {
              throw new Error("查無即時股價");
            }

            const costValue = position.averageCost * position.shares;
            const marketValue = price * position.shares;
            const profit = marketValue - costValue;
            const profitPercent = (profit / costValue) * 100;

            return {
              code,
              name: stockNames[code] || code,
              shares: position.shares,
              averageCost: position.averageCost,
              price,
              costValue,
              marketValue,
              profit,
              profitPercent
            };
          } catch {
            return {
              code,
              name: stockNames[code] || code,
              shares: position.shares,
              averageCost: position.averageCost,
              error: true
            };
          }
        })(),
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                code,
                name: stockNames[code] || code,
                shares: position.shares,
                averageCost: position.averageCost,
                error: true
              }),
            raceMs
          )
        )
      ])
    )
  );
};

const formatMoney = (value) => Number(value).toFixed(0);
const formatPercent = (value) => Number(value).toFixed(2);
const profitSign = (value) => (value > 0 ? "+" : "");

const formatPortfolioSnapshot = (item) => {
  if (item.error) {
    return `${item.name}（${item.code}）：即時損益查詢失敗`;
  }

  const sign = profitSign(item.profit);
  return `${item.name}（${item.code}）
持有：${item.shares} 股｜成本：${item.averageCost} 元
現價：${item.price} 元｜損益：${sign}${formatMoney(item.profit)} 元（${sign}${formatPercent(item.profitPercent)}%）`;
};

const portfolioTotals = (snapshots) => {
  const successful = snapshots.filter((item) => !item.error);
  const totalCost = successful.reduce((sum, item) => sum + item.costValue, 0);
  const totalMarket = successful.reduce((sum, item) => sum + item.marketValue, 0);
  const totalProfit = totalMarket - totalCost;
  const totalPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

  return {
    successful,
    failedCount: snapshots.length - successful.length,
    totalCost,
    totalMarket,
    totalProfit,
    totalPercent
  };
};

const portfolioImportMatch = userMessage.trim().match(/^匯入持股\s*\n([\s\S]+)$/);
if (portfolioImportMatch) {
  const lines = portfolioImportMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const portfolio = new Map();
  const invalidLines = [];

  for (const line of lines) {
    const columns = line.split(/\s+/);
    if (columns.length !== 3) {
      invalidLines.push(line);
      continue;
    }

    const code = resolveStockCode(columns[0]);
    const shares = Number(columns[1].replace(/,/g, ""));
    const averageCost = Number(columns[2].replace(/,/g, ""));
    if (!/^\d{4,6}$/.test(code) || shares <= 0 || averageCost <= 0) {
      invalidLines.push(line);
      continue;
    }

    portfolio.set(code, { shares, averageCost });
  }

  if (portfolio.size === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "匯入失敗。每行請使用：股票代號 股數 平均成本"
    });
  }

  await replacePortfolio(watchlistKey, portfolio);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📥 已匯入 ${portfolio.size} 檔持股${
      invalidLines.length > 0
        ? `\n⚠️ ${invalidLines.length} 行格式錯誤，未匯入。`
        : ""
    }\n\n輸入「我的持股」即可查看即時損益。${
      hasPortfolioDb ? "" : "\n\n提醒：目前未設定資料庫，Railway 重啟後資料會清空。"
    }`
  });
}

const portfolioAddMatch = userMessage
  .trim()
  .match(/^持股\+\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
if (portfolioAddMatch) {
  const code = resolveStockCode(portfolioAddMatch[1]);
  const shares = Number(portfolioAddMatch[2]);
  const averageCost = Number(portfolioAddMatch[3]);

  if (!/^\d{4,6}$/.test(code) || shares <= 0 || averageCost <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：持股+台積電 35 2000\n代表 35 股，平均成本 2000 元。"
    });
  }

  await savePortfolioPosition(watchlistKey, code, { shares, averageCost });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `💼 已儲存持股：${stockNames[code] || code}（${code}）
持有股數：${shares} 股
平均成本：${averageCost} 元`
  });
}

const portfolioRemoveMatch = userMessage.trim().match(/^持股-\s*(.+)$/);
if (portfolioRemoveMatch) {
  const code = resolveStockCode(portfolioRemoveMatch[1]);
  await deletePortfolioPosition(watchlistKey, code);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已移除持股：${stockNames[code] || code}（${code}）`
  });
}

const alertAddMatch = userMessage
  .trim()
  .match(/^提醒\+\s*(\S+)\s+(\d+(?:\.\d+)?)(?:\s*(以上|以下|above|below))?$/i);
if (alertAddMatch) {
  const code = resolveStockCode(alertAddMatch[1]);
  const targetPrice = Number(alertAddMatch[2]);
  const direction = normalizeAlertDirection(alertAddMatch[3] || "以上");

  if (!/^\d{4,6}$/.test(code) || targetPrice <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：提醒+台積電 2500 以上"
    });
  }

  await savePriceAlert(watchlistKey, { code, targetPrice, direction });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🔔 已新增價格提醒：${stockNames[code] || code}（${code}）
條件：${targetPrice} 元 ${alertDirectionLabel(direction)}

輸入「檢查提醒」即可檢查是否到價。`
  });
}

const alertRemoveMatch = userMessage.trim().match(/^提醒-\s*(.+)$/);
if (alertRemoveMatch) {
  const code = resolveStockCode(alertRemoveMatch[1]);
  await deletePriceAlert(watchlistKey, code);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已移除價格提醒：${stockNames[code] || code}（${code}）`
  });
}

if (userMessage.trim() === "提醒列表") {
  const alerts = await getPriceAlerts(watchlistKey);
  if (alerts.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有價格提醒。可輸入：提醒+台積電 2500 以上"
    });
  }

  const rows = alerts
    .map(
      (alert, index) =>
        `${index + 1}. ${stockNames[alert.code] || alert.code}（${alert.code}）：${
          alert.targetPrice
        } 元 ${alertDirectionLabel(alert.direction)}`
    )
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📋 價格提醒列表\n\n${rows}`
  });
}

if (userMessage.trim() === "檢查提醒") {
  const alerts = await getPriceAlerts(watchlistKey);
  if (alerts.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有價格提醒。可輸入：提醒+台積電 2500 以上"
    });
  }

  const results = await Promise.all(
    alerts.map(async (alert) => {
      try {
        const quote = await fetchYahooQuote(alert.code, 2500);
        const price = Number(quote.regularMarketPrice);
        const triggered =
          alert.direction === "below"
            ? price <= alert.targetPrice
            : price >= alert.targetPrice;

        if (triggered) {
          await deactivatePriceAlert(watchlistKey, alert.code, alert.direction);
        }

        return `${triggered ? "✅ 到價" : "⏳ 未到"} ${stockNames[alert.code] || alert.code}（${
          alert.code
        }）
現價：${price} 元｜條件：${alert.targetPrice} 元 ${alertDirectionLabel(
          alert.direction
        )}${triggered ? "\n此提醒已自動關閉。" : ""}`;
      } catch {
        return `⚠️ ${stockNames[alert.code] || alert.code}（${alert.code}）：報價查詢失敗`;
      }
    })
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🔎 價格提醒檢查\n\n${results.join("\n\n")}`
  });
}

const buyTradeMatch = userMessage
  .trim()
  .match(/^買進\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+.*)?$/);
if (buyTradeMatch) {
  const code = resolveStockCode(buyTradeMatch[1]);
  const buyShares = Number(buyTradeMatch[2]);
  const buyPrice = Number(buyTradeMatch[3]);
  const buyAmount = buyShares * buyPrice;
  const fee = parseOptionalMoney(userMessage, "手續費") ?? estimateBuyFee(buyAmount);

  if (!/^\d{4,6}$/.test(code) || buyShares <= 0 || buyPrice <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：買進 台積電 10 2380"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const current = portfolio.get(code) || { shares: 0, averageCost: 0 };
  const newShares = current.shares + buyShares;
  const newAverageCost =
    newShares > 0
      ? (current.shares * current.averageCost + buyAmount + fee) / newShares
      : buyPrice;

  await savePortfolioPosition(watchlistKey, code, {
    shares: newShares,
    averageCost: Number(newAverageCost.toFixed(4))
  });
  await recordTrade(watchlistKey, {
    code,
    type: "buy",
    shares: buyShares,
    price: buyPrice,
    fee,
    tax: 0,
    realizedProfit: 0
  });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧾 已記錄買進：${stockNames[code] || code}（${code}）
買進：${buyShares} 股｜價格：${buyPrice} 元
手續費：${fee} 元
目前持有：${newShares} 股
新平均成本：${newAverageCost.toFixed(2)} 元`
  });
}

const sellTradeMatch = userMessage
  .trim()
  .match(/^賣出\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+.*)?$/);
if (sellTradeMatch) {
  const code = resolveStockCode(sellTradeMatch[1]);
  const sellShares = Number(sellTradeMatch[2]);
  const sellPrice = Number(sellTradeMatch[3]);
  const sellAmount = sellShares * sellPrice;
  const fee = parseOptionalMoney(userMessage, "手續費") ?? estimateSellFee(sellAmount);
  const tax = parseOptionalMoney(userMessage, "交易稅") ?? estimateSellTax(sellAmount);

  if (!/^\d{4,6}$/.test(code) || sellShares <= 0 || sellPrice <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：賣出 台積電 5 2450"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const current = portfolio.get(code);
  if (!current || current.shares < sellShares) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `賣出失敗：${stockNames[code] || code}（${code}）目前持股不足。`
    });
  }

  const realizedProfit = (sellPrice - current.averageCost) * sellShares - fee - tax;
  const remainingShares = current.shares - sellShares;

  if (remainingShares > 0) {
    await savePortfolioPosition(watchlistKey, code, {
      shares: remainingShares,
      averageCost: current.averageCost
    });
  } else {
    await deletePortfolioPosition(watchlistKey, code);
  }

  await recordTrade(watchlistKey, {
    code,
    type: "sell",
    shares: sellShares,
    price: sellPrice,
    fee,
    tax,
    realizedProfit
  });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `💸 已記錄賣出：${stockNames[code] || code}（${code}）
賣出：${sellShares} 股｜價格：${sellPrice} 元
平均成本：${current.averageCost} 元
手續費：${fee} 元｜交易稅：${tax} 元
已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)} 元
剩餘持股：${remainingShares} 股`
  });
}

if (userMessage.trim() === "交易紀錄") {
  const trades = await getTrades(watchlistKey);
  if (trades.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有交易紀錄。可輸入：買進 台積電 10 2380"
    });
  }

  const rows = trades
    .slice(0, 10)
    .map((trade, index) => {
      const typeLabel = trade.type === "buy" ? "買進" : "賣出";
      const realized =
        trade.type === "sell"
          ? `｜已實現：${profitSign(trade.realizedProfit)}${formatMoney(
              trade.realizedProfit
            )} 元`
          : "";
      const costs =
        trade.type === "sell"
          ? `｜手續費${formatMoney(trade.fee || 0)}｜稅${formatMoney(
              trade.tax || 0
            )}`
          : `｜手續費${formatMoney(trade.fee || 0)}`;
      const date = trade.tradedAt
        ? new Date(trade.tradedAt).toLocaleString("zh-TW")
        : "剛剛";

      return `${index + 1}. ${typeLabel} ${stockNames[trade.code] || trade.code}（${
        trade.code
      }）
${trade.shares} 股｜${trade.price} 元${costs}${realized}
${date}`;
    })
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📜 最近交易紀錄\n\n${rows}`
  });
}

const dividendMatch = userMessage
  .trim()
  .match(/^(股息|股利)\s*(\S+)\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
if (dividendMatch) {
  const code = resolveStockCode(dividendMatch[2]);
  const amount = Number(dividendMatch[3]);
  const note = dividendMatch[4] || dividendMatch[1];

  if (!/^\d{4,6}$/.test(code) || amount <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：股息 台積電 1000"
    });
  }

  await recordDividend(watchlistKey, { code, amount, note });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 已記錄股息/股利：${stockNames[code] || code}（${code}）
金額：${formatMoney(amount)} 元
備註：${note}`
  });
}

const annualDividendLines = userMessage
  .trim()
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (
  annualDividendLines.length > 1 &&
  annualDividendLines.every((line) => /^年度股利\s*\d{4}\s+\d+(?:\.\d+)?/.test(line))
) {
  const invalidLines = [];
  const savedRows = [];

  for (const line of annualDividendLines) {
    const match = line.match(/^年度股利\s*(\d{4})\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
    if (!match) {
      invalidLines.push(line);
      continue;
    }

    const year = match[1];
    const amount = Number(match[2]);
    const note = match[3] || `${year} 年度股利總額`;
    if (amount <= 0) {
      invalidLines.push(line);
      continue;
    }

    await recordDividend(watchlistKey, {
      code: "TOTAL",
      amount,
      note
    });
    savedRows.push(`${year}：${formatMoney(amount)} 元`);
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 已批次記錄年度股利

${savedRows.join("\n")}${
      invalidLines.length > 0
        ? `\n\n⚠️ ${invalidLines.length} 行格式錯誤，未匯入。`
        : ""
    }

輸入「股息紀錄」可查看累計股息/股利。`
  });
}

const annualDividendMatch = userMessage
  .trim()
  .match(/^年度股利\s*(\d{4})\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
if (annualDividendMatch) {
  const year = annualDividendMatch[1];
  const amount = Number(annualDividendMatch[2]);
  const note = annualDividendMatch[3] || `${year} 年度股利總額`;

  if (amount <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：年度股利 2026 3407"
    });
  }

  await recordDividend(watchlistKey, {
    code: "TOTAL",
    amount,
    note
  });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 已記錄年度股利
年度：${year}
金額：${formatMoney(amount)} 元
備註：${note}`
  });
}

const dividendDeleteMatch = userMessage
  .trim()
  .match(/^(股息刪除|股利刪除|刪除股息|刪除股利)\s*(\d+)$/);
if (dividendDeleteMatch) {
  const index = Number(dividendDeleteMatch[2]);
  const dividend = await deleteDividendAt(watchlistKey, index);
  if (!dividend) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `找不到第 ${index} 筆股息/股利紀錄。\n請先輸入「股息紀錄」確認序號。`
    });
  }

  const dividendName =
    dividend.code === "TOTAL"
      ? "年度股利總額"
      : `${stockNames[dividend.code] || dividend.code}（${dividend.code}）`;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已刪除股息/股利紀錄
第 ${index} 筆：${dividendName}
金額：${formatMoney(dividend.amount)} 元
備註：${dividend.note || "股息"}

輸入「股息紀錄」可確認最新總額。`
  });
}

if (userMessage.trim() === "股息紀錄" || userMessage.trim() === "股利紀錄") {
  const dividends = await getDividends(watchlistKey);
  if (dividends.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有股息/股利紀錄。可輸入：股息 台積電 1000"
    });
  }

  const rows = dividends
    .slice(0, 10)
    .map((dividend, index) => {
      const date = dividend.receivedAt
        ? new Date(dividend.receivedAt).toLocaleString("zh-TW")
        : "剛剛";
      const dividendName =
        dividend.code === "TOTAL"
          ? "年度股利總額"
          : `${stockNames[dividend.code] || dividend.code}（${dividend.code}）`;
      return `${index + 1}. ${dividendName}
金額：${formatMoney(dividend.amount)} 元｜${dividend.note || "股息"}
${date}`;
    })
    .join("\n\n");

  const total = await getDividendTotal(watchlistKey);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 股息/股利紀錄

累計股息/股利：${formatMoney(total)} 元

${rows}`
  });
}

if (userMessage.trim() === "已實現損益") {
  const realizedProfit = await getRealizedProfit(watchlistKey);
  const dividendTotal = await getDividendTotal(watchlistKey);
  const total = realizedProfit + dividendTotal;
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `💰 已實現損益

交易已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)} 元
累計股息/股利：${formatMoney(dividendTotal)} 元
合計已實現總收益：${profitSign(total)}${formatMoney(total)} 元

提醒：買賣試算已納入手續費與交易稅；稅費可手動輸入，未輸入時使用預設估算。`
  });
}

if (
  userMessage.trim() === "今日總結" ||
  userMessage.trim() === "持股日報" ||
  userMessage.trim() === "盤後總結"
) {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法產生今日總結。請先輸入「匯入持股」建立資料。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  const realizedProfit = await getRealizedProfit(watchlistKey);
  const dividendTotal = await getDividendTotal(watchlistKey);
  const alerts = await getPriceAlerts(watchlistKey);
  const totalReturn = totals.totalProfit + realizedProfit + dividendTotal;

  const strongest = [...totals.successful]
    .sort((a, b) => b.profitPercent - a.profitPercent)
    .slice(0, 3);
  const weakest = [...totals.successful]
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 3);

  const formatDailyRank = (items) =>
    items.length > 0
      ? items
          .map(
            (item, index) =>
              `${index + 1}. ${item.name}（${item.code}）：${profitSign(
                item.profitPercent
              )}${formatPercent(item.profitPercent)}%，損益 ${profitSign(
                item.profit
              )}${formatMoney(item.profit)} 元`
          )
          .join("\n")
      : "暫無可計算資料";

  const aiInput = totals.successful
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit))
    .slice(0, 8)
    .map(
      (item) =>
        `${item.name}(${item.code}) 報酬${profitSign(item.profitPercent)}${formatPercent(
          item.profitPercent
        )}% 損益${profitSign(item.profit)}${formatMoney(item.profit)} 市值${formatMoney(
          item.marketValue
        )}`
    )
    .join("\n");

  let aiSummary = "今日資料已整理完成，請搭配市場風險自行評估。";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "你是台股持股日報助理。用繁體中文，語氣務實精簡，不保證獲利，不使用 Markdown 粗體符號。"
        },
        {
          role: "user",
          content: `請根據以下資料寫 3 句今日持股摘要，最後加 1 句風險提醒。

持股檔數：${entries.length}
總成本：${formatMoney(totals.totalCost)}
總市值：${formatMoney(totals.totalMarket)}
未實現損益：${profitSign(totals.totalProfit)}${formatMoney(totals.totalProfit)}
總報酬率：${profitSign(totals.totalPercent)}${formatPercent(totals.totalPercent)}%
已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)}
股息股利：${formatMoney(dividendTotal)}
提醒數量：${alerts.length}

主要持股資料：
${aiInput}`
        }
      ],
      max_tokens: 280
    });
    aiSummary = completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("今日總結 AI 摘要失敗:", error.message);
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗓️ 今日持股總結
${new Date().toLocaleString("zh-TW")}

📌 資產概況
持股檔數：${entries.length} 檔
總成本：${formatMoney(totals.totalCost)} 元
總市值：${formatMoney(totals.totalMarket)} 元
未實現損益：${profitSign(totals.totalProfit)}${formatMoney(totals.totalProfit)} 元
總報酬率：${profitSign(totals.totalPercent)}${formatPercent(totals.totalPercent)}%
已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)} 元
股息/股利：${formatMoney(dividendTotal)} 元
含股息總收益：${profitSign(totalReturn)}${formatMoney(totalReturn)} 元

📈 表現較強
${formatDailyRank(strongest)}

📉 表現較弱
${formatDailyRank(weakest)}

🔔 價格提醒
目前啟用：${alerts.length} 筆

🧠 AI 簡短解讀
${aiSummary}${
      totals.failedCount > 0
        ? `\n\n提醒：${totals.failedCount} 檔即時報價查詢失敗，未列入總結。`
        : ""
    }`
  });
}

if (userMessage.trim() === "持股總覽" || userMessage.trim() === "資產總覽") {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料。輸入「匯入持股」即可建立你的持股資料庫。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries);
  const totals = portfolioTotals(snapshots);
  const realizedProfit = await getRealizedProfit(watchlistKey);
  const dividendTotal = await getDividendTotal(watchlistKey);
  const totalReturn = totals.totalProfit + realizedProfit + dividendTotal;
  const sign = profitSign(totals.totalProfit);
  const totalReturnSign = profitSign(totalReturn);
  const topWeights = totals.successful
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${formatPercent(
          (item.marketValue / totals.totalMarket) * 100
        )}%`
    )
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📊 持股總覽

持股檔數：${entries.length} 檔
總成本：${formatMoney(totals.totalCost)} 元
總市值：${formatMoney(totals.totalMarket)} 元
未實現損益：${sign}${formatMoney(totals.totalProfit)} 元
總報酬率：${sign}${formatPercent(totals.totalPercent)}%
已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)} 元
股息/股利：${formatMoney(dividendTotal)} 元
含股息總收益：${totalReturnSign}${formatMoney(totalReturn)} 元

前五大持股比重：
${topWeights || "暫無可計算資料"}${
      totals.failedCount > 0
        ? `\n\n提醒：${totals.failedCount} 檔即時報價查詢失敗，未列入總覽。`
        : ""
    }

提醒：買賣紀錄會納入手續費與交易稅；手動匯入的舊持股成本不會自動補歷史費用。`
  });
}

if (userMessage.trim() === "損益排行" || userMessage.trim() === "持股排行") {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法建立損益排行。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries);
  const totals = portfolioTotals(snapshots);
  const winners = [...totals.successful]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${profitSign(item.profit)}${formatMoney(
          item.profit
        )} 元（${profitSign(item.profitPercent)}${formatPercent(item.profitPercent)}%）`
    )
    .join("\n");
  const losers = [...totals.successful]
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${profitSign(item.profit)}${formatMoney(
          item.profit
        )} 元（${profitSign(item.profitPercent)}${formatPercent(item.profitPercent)}%）`
    )
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🏆 損益排行

賺最多前 5 名：
${winners || "暫無可計算資料"}

賠最多前 5 名：
${losers || "暫無可計算資料"}${
      totals.failedCount > 0
        ? `\n\n提醒：${totals.failedCount} 檔即時報價查詢失敗，未列入排行。`
        : ""
    }`
  });
}

const singlePortfolioMatch = userMessage.trim().match(/^持股\s*(\S+)$/);
if (
  singlePortfolioMatch &&
  !["持股", "持股總覽", "持股排行"].includes(userMessage.trim())
) {
  const portfolio = await getPortfolio(watchlistKey);
  const code = resolveStockCode(singlePortfolioMatch[1]);
  const position = portfolio.get(code);

  if (!position) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `目前沒有 ${stockNames[code] || code}（${code}）的持股資料。`
    });
  }

  const [snapshot] = await getPortfolioSnapshots([[code, position]]);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🔎 單一持股查詢\n\n${formatPortfolioSnapshot(snapshot)}`
  });
}

if (userMessage.trim() === "健檢持股" || userMessage.trim() === "AI持股健檢") {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法健檢。請先輸入「匯入持股」建立資料。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries);
  const totals = portfolioTotals(snapshots);
  const realizedProfit = await getRealizedProfit(watchlistKey);
  const dividendTotal = await getDividendTotal(watchlistKey);
  const holdingLines = totals.successful
    .map(
      (item) =>
        `${item.name}(${item.code}) 持有${item.shares}股 成本${item.averageCost} 現價${item.price} 市值${formatMoney(
          item.marketValue
        )} 損益${profitSign(item.profit)}${formatMoney(item.profit)} 報酬${profitSign(
          item.profitPercent
        )}${formatPercent(item.profitPercent)}% 比重${formatPercent(
          (item.marketValue / totals.totalMarket) * 100
        )}%`
    )
    .join("\n");

  const healthPrompt = `請根據以下台股持股資料做繁體中文持股健檢。
請不要保證獲利，不要使用 Markdown 粗體符號。
請用 5 點回答：
1. 整體損益狀態
2. 持股集中度
3. 需要優先留意的持股
4. 可觀察的調整方向
5. 風險提醒

總成本：${formatMoney(totals.totalCost)}
總市值：${formatMoney(totals.totalMarket)}
總損益：${profitSign(totals.totalProfit)}${formatMoney(totals.totalProfit)}
總報酬率：${profitSign(totals.totalPercent)}${formatPercent(totals.totalPercent)}%
交易已實現損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)}
股息/股利：${formatMoney(dividendTotal)}

持股明細：
${holdingLines}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "你是台股持股健檢助理。根據使用者提供的持股數據分析，使用繁體中文，務實、精簡、不做買賣保證。"
      },
      {
        role: "user",
        content: healthPrompt
      }
    ],
    max_tokens: 700
  });

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧠 AI 持股健檢\n\n${completion.choices[0].message.content.trim()}`
  });
}

if (userMessage.trim() === "我的持股" || userMessage.trim() === "持股") {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料。輸入「持股+台積電 35 2000」即可新增。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries);
  const rows = snapshots.map(formatPortfolioSnapshot);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `💼 我的持股\n\n${rows.join("\n\n")}\n\n提醒：買賣紀錄會納入手續費與交易稅；手動匯入的舊持股成本不會自動補歷史費用。${
      hasPortfolioDb ? "" : "Railway 重啟後，持股資料會暫時清空。"
    }`
  });
}

const watchlistMatch = userMessage.trim().match(/^自選([+-])\s*(.+)$/);
if (watchlistMatch) {
  const action = watchlistMatch[1];
  const code = resolveStockCode(watchlistMatch[2]);
  if (!/^\d{4,6}$/.test(code)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "找不到這支股票，請輸入股票名稱或代號。"
    });
  }

  const list = watchlists.get(watchlistKey) || new Set();
  if (action === "+") {
    list.add(code);
  } else {
    list.delete(code);
  }
  watchlists.set(watchlistKey, list);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      action === "+"
        ? `⭐ 已加入自選：${stockNames[code] || code}（${code}）`
        : `🗑️ 已移除自選：${stockNames[code] || code}（${code}）`
  });
}

if (userMessage.trim() === "自選股") {
  const list = [...(watchlists.get(watchlistKey) || [])];
  if (list.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有自選股。輸入「自選+台積電」即可加入。"
    });
  }

  const rows = await Promise.all(
    list.map(async (code) => {
      try {
        const meta = await fetchYahooQuote(code);
        const price = meta?.regularMarketPrice ?? "暫無資料";
        const previousClose = meta?.previousClose;
        const percent =
          Number.isFinite(price) && Number.isFinite(previousClose)
            ? (((price - previousClose) / previousClose) * 100).toFixed(2)
            : "暫無資料";
        return `${stockNames[code] || code}（${code}）：${price} 元，${percent}%`;
      } catch {
        return `${stockNames[code] || code}（${code}）：查詢失敗`;
      }
    })
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `⭐ 我的自選股\n\n${rows.join("\n")}\n\n提醒：Railway 重啟後，自選清單會暫時清空。`
  });
}

const cleanInput = userMessage.trim();
const analysisMatch = cleanInput.match(/^分析\s*(.+)$/);
const institutionalMatch = cleanInput.match(/^法人\s*(.+)$/);
const marginMatch = cleanInput.match(/^籌碼\s*(.+)$/);
const newsMatch = cleanInput.match(/^新聞\s*(.+)$/);
const chartMatch = cleanInput.match(/^[KkＫｋ]線\s*(.+)$/);
const stockInput = analysisMatch
  ? analysisMatch[1].trim()
  : institutionalMatch
  ? institutionalMatch[1].trim()
  : marginMatch
  ? marginMatch[1].trim()
  : newsMatch
  ? newsMatch[1].trim()
  : chartMatch
  ? chartMatch[1].trim()
  : cleanInput;

const isAnalysisQuery = Boolean(analysisMatch);
const isInstitutionalQuery = Boolean(institutionalMatch);
const isMarginQuery = Boolean(marginMatch);
const isNewsQuery = Boolean(newsMatch);
const isChartQuery = Boolean(chartMatch);
let pureCode = stockInput;

// 如果輸入的是中文（例如台積電），就轉成代號
if (reverseStockNames[stockInput]) {
  pureCode = reverseStockNames[stockInput];
}

// 股票名稱
const stockName = stockNames[pureCode] || stockInput;

const isStockQuery =
  /^\d{4,6}$/.test(pureCode) ||
  Boolean(reverseStockNames[stockInput]);

if (isStockQuery) {
  try {
    const result = await fetchYahooQuote(pureCode);
    if (!result) {
      throw new Error("Yahoo 查無股票資料");
    }

    const stockPrice = result.regularMarketPrice;
    const previousClose = result.previousClose;
    const openPrice =
      result.regularMarketOpen ??
      result.previousClose ??
      "暫無資料";
    const highPrice = result.regularMarketDayHigh ?? "暫無資料";
    const lowPrice = result.regularMarketDayLow ?? "暫無資料";

    const change = (stockPrice - previousClose).toFixed(1);
    const percent = (
      ((stockPrice - previousClose) / previousClose) *
      100
    ).toFixed(2);

    const startDate = new Date(Date.now() - 30 * 86400000)
      .toISOString()
      .slice(0, 10);

    const finRes = await axios.get(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${pureCode}&start_date=${startDate}`,
      { headers: { Authorization: `Bearer ${FINMIND_TOKEN}` } }
    );

    const closes = (finRes.data?.data || [])
      .slice(-5)
      .map((item) => Number(item.close))
      .filter(Number.isFinite);

    const ma5 =
      closes.length === 5
        ? (closes.reduce((sum, value) => sum + value, 0) / 5).toFixed(2)
        : "資料不足";
    if (isChartQuery) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `📉 ${stockName}（${pureCode}）K 線圖\nhttps://tw.stock.yahoo.com/quote/${pureCode}/technical-analysis`
      });
    }
    if (isNewsQuery) {
      const newsRes = await axios.get(
        "https://news.google.com/rss/search",
        {
          params: {
            q: `${stockName} 股票 when:7d`,
            hl: "zh-TW",
            gl: "TW",
            ceid: "TW:zh-Hant"
          }
        }
      );

      const $ = cheerio.load(newsRes.data, { xmlMode: true });
      const newsItems = $("item")
        .slice(0, 5)
        .map((_, item) => ({
          title: $(item).find("title").text().trim(),
          publisher: $(item).find("source").text().trim(),
          link: $(item).find("link").text().trim()
        }))
        .get();
      if (newsItems.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `目前查無 ${stockName}（${pureCode}）的近期新聞。`
        });
      }

      const headlines = newsItems
        .map(
          (item, index) =>
            `${index + 1}. ${item.title}\n來源：${item.publisher || "Yahoo 財經"}\n${item.link}`
        )
        .join("\n\n");

      const summaryPrompt = `請用繁體中文整理以下 ${stockName} 新聞標題。
不要使用 Markdown 符號，不要推測標題沒有提供的內容。
先用三句話摘要可能影響，再列出需要留意的風險。

${newsItems.map((item) => `- ${item.title}`).join("\n")}`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "你是台股新聞摘要助理。只能根據提供的新聞標題摘要，使用繁體中文，內容精簡易讀。"
          },
          {
            role: "user",
            content: summaryPrompt
          }
        ],
        max_tokens: 350
      });

      return client.replyMessage(event.replyToken, [
        {
          type: "text",
          text: `📰 ${stockName}（${pureCode}）新聞摘要\n\n${completion.choices[0].message.content.trim()}`
        },
        {
          type: "text",
          text: `🔗 近期新聞\n\n${headlines}`
        }
      ]);
    }
    if (isMarginQuery) {
      const marginRes = await axios.get(
        `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${pureCode}&start_date=${startDate}`,
        { headers: { Authorization: `Bearer ${FINMIND_TOKEN}` } }
      );

      const marginData = marginRes.data?.data || [];
      if (marginData.length === 0) {
        throw new Error("查無融資融券資料");
      }

      const latest = marginData[marginData.length - 1];
      const marginChange =
        Number(latest.MarginPurchaseTodayBalance) -
        Number(latest.MarginPurchaseYesterdayBalance);
      const shortChange =
        Number(latest.ShortSaleTodayBalance) -
        Number(latest.ShortSaleYesterdayBalance);

      const showChange = (value) =>
        `${value > 0 ? "+" : ""}${value} 張`;

      const marginReply = `📊 ${stockName}（${pureCode}）融資融券籌碼
🗓️ 日期：${latest.date}

💰 融資餘額：${latest.MarginPurchaseTodayBalance} 張
📈 融資增減：${showChange(marginChange)}

📉 融券餘額：${latest.ShortSaleTodayBalance} 張
🔄 融券增減：${showChange(shortChange)}`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: marginReply
      });
    }
    if (isInstitutionalQuery) {
      const chipRes = await axios.get(
        `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${pureCode}&start_date=${startDate}`,
        { headers: { Authorization: `Bearer ${FINMIND_TOKEN}` } }
      );

      const chipData = chipRes.data?.data || [];
      if (chipData.length === 0) {
        throw new Error("查無法人買賣資料");
      }

      const latestDate = chipData[chipData.length - 1].date;
      const latestRows = chipData.filter((item) => item.date === latestDate);

      const netLots = (...names) =>
        (
          latestRows
            .filter((item) => names.includes(item.name))
            .reduce(
              (sum, item) => sum + Number(item.buy) - Number(item.sell),
              0
            ) / 1000
        ).toFixed(0);

      const foreign = netLots("Foreign_Investor");
      const trust = netLots("Investment_Trust");
      const dealer = netLots("Dealer_self", "Dealer_Hedging");
      const total = (
        Number(foreign) +
        Number(trust) +
        Number(dealer)
      ).toFixed(0);

      const showLots = (value) =>
        `${Number(value) > 0 ? "+" : ""}${value} 張`;

      const chipReply = `🏦 ${stockName}（${pureCode}）法人買賣
🗓️ 日期：${latestDate}

🌍 外資：${showLots(foreign)}
🏢 投信：${showLots(trust)}
🏦 自營商：${showLots(dealer)}
📊 三大法人合計：${showLots(total)}`;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: chipReply
      });
    }
if (isAnalysisQuery) {
      const analysisPrompt = `請根據以下真實行情，提供簡潔的繁體中文技術分析。
不要使用 Markdown 符號，不要保證獲利，結尾提醒投資人自行評估風險。

股票：${stockName}（${pureCode}）
現價：${stockPrice} 元
前收：${previousClose} 元
漲跌：${change} 元
漲幅：${percent}%
五日均線：${ma5} 元
今日開盤：${openPrice} 元
今日最高：${highPrice} 元
今日最低：${lowPrice} 元

請依序說明：
1. 今日走勢
2. 現價與五日均線關係
3. 短線觀察重點
4. 風險提醒`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "你是台股技術分析助理。只能根據提供的行情分析，使用繁體中文，內容精簡易讀。"
          },
          {
            role: "user",
            content: analysisPrompt
          }
        ],
        max_tokens: 500
      });

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: completion.choices[0].message.content.trim()
      });
    }
    const trendIcon =
      Number(change) > 0
        ? "📈"
        : Number(change) < 0
        ? "📉"
        : "➖";

    const now = new Date().toLocaleString("zh-TW");

    const stockReply = `📈 ${stockName}（${pureCode}）
🕒 更新時間：${now}
💰 現價：${stockPrice} 元
📈 漲跌：${change} 元 ${trendIcon}
📊 漲幅：${percent}% ${trendIcon}
📉 五日均線：${ma5} 元

🔓 開盤：${openPrice} 元
⬆️ 最高：${highPrice} 元
⬇️ 最低：${lowPrice} 元`;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: stockReply
    });
  } catch (error) {
    console.error("股票查詢錯誤:", error.message);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "股票查詢失敗 😢"
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

app.get('/alerts/check', async (req, res) => {
  try {
    await checkAndPushPriceAlerts();
    res.json({ ok: true });
  } catch (error) {
    console.error("手動觸發價格提醒失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =================【4. 啟動伺服器】=================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  if (hasPortfolioDb) {
    console.log(
      `Auto price alerts enabled. Interval: ${Math.round(
        ALERT_CHECK_INTERVAL_MS / 1000
      )} seconds`
    );
    setInterval(() => {
      checkAndPushPriceAlerts().catch((error) => {
        console.error("自動價格提醒排程失敗:", error);
      });
    }, ALERT_CHECK_INTERVAL_MS);
  } else {
    console.log("Auto price alerts disabled: database is not enabled");
  }
});
