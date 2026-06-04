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
const portfolioBackups = new Map();
const portfolioValueSnapshots = new Map();
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

const backupApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_backups`;

const valueSnapshotApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_value_snapshots`;

const parseOptionalMoney = (text, label) => {
  const match = text.match(new RegExp(`${label}\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
};

const parseNumberToken = (value) => {
  const number = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : NaN;
};

const parseHistoricalTradeDate = (value) => {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const yyyy = year.padStart(4, "0");
  const mm = month.padStart(2, "0");
  const dd = day.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00+08:00`;
};

const parseTradeTypeToken = (value) => {
  const text = String(value || "").trim().toLowerCase();
  if (["買進", "買入", "buy", "b"].includes(text)) {
    return "buy";
  }
  if (["賣出", "sell", "s"].includes(text)) {
    return "sell";
  }
  return null;
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

const portfolioToRows = (portfolio) =>
  [...portfolio.entries()]
    .sort(([codeA], [codeB]) => codeA.localeCompare(codeB))
    .map(([code, position]) => ({
      code,
      shares: Number(position.shares),
      averageCost: Number(position.averageCost)
    }));

const rowsToPortfolio = (rows = []) => {
  const portfolio = new Map();
  for (const row of rows) {
    const code = resolveStockCode(row.code);
    const shares = Number(row.shares);
    const averageCost = Number(row.averageCost);
    if (/^\d{4,6}$/.test(code) && shares > 0 && averageCost > 0) {
      portfolio.set(code, { shares, averageCost });
    }
  }
  return portfolio;
};

const savePortfolioBackup = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const rows = portfolioToRows(portfolio);
  if (rows.length === 0) {
    return null;
  }

  const savedAt = new Date().toISOString();
  if (!hasPortfolioDb) {
    portfolioBackups.set(ownerKey, { rows, savedAt });
    return { rows, savedAt };
  }

  await axios.post(
    `${backupApiUrl()}?on_conflict=owner_key`,
    {
      owner_key: ownerKey,
      portfolio: rows,
      updated_at: savedAt
    },
    {
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
    }
  );

  return { rows, savedAt };
};

const getPortfolioBackup = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolioBackups.get(ownerKey) || null;
  }

  const response = await axios.get(backupApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "portfolio,updated_at",
      limit: 1
    }
  });

  const row = response.data?.[0];
  if (!row) {
    return null;
  }

  return {
    rows: Array.isArray(row.portfolio) ? row.portfolio : [],
    savedAt: row.updated_at
  };
};

const restorePortfolioBackup = async (ownerKey) => {
  const backup = await getPortfolioBackup(ownerKey);
  if (!backup || backup.rows.length === 0) {
    return null;
  }

  const portfolio = rowsToPortfolio(backup.rows);
  if (portfolio.size === 0) {
    return null;
  }

  await replacePortfolio(ownerKey, portfolio);
  return {
    ...backup,
    portfolio
  };
};

const recordTrade = async (ownerKey, trade) => {
  const tradedAt = trade.tradedAt || new Date().toISOString();

  if (!hasPortfolioDb) {
    const trades = portfolioTrades.get(ownerKey) || [];
    trades.push({ ...trade, tradedAt });
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
      realized_profit: trade.realizedProfit || 0,
      traded_at: tradedAt
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
      select: "id,code,trade_type,shares,price,fee,tax,realized_profit,traded_at",
      order: "traded_at.desc",
      limit: 20
    }
  });

  return (response.data || []).map((row) => ({
    id: row.id,
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

const deleteTradeAt = async (ownerKey, index) => {
  const trades = await getTrades(ownerKey);
  const trade = trades[index - 1];
  if (!trade) {
    return null;
  }

  if (!hasPortfolioDb) {
    const savedTrades = portfolioTrades.get(ownerKey) || [];
    savedTrades.splice(index - 1, 1);
    portfolioTrades.set(ownerKey, savedTrades);
    return trade;
  }

  await axios.delete(tradeApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      id: `eq.${trade.id}`
    }
  });

  return trade;
};

const rollbackBuyTradePosition = async (ownerKey, trade) => {
  if (!trade || trade.type !== "buy") {
    return { rolledBack: false, reason: "只支援買進交易回復" };
  }

  const portfolio = await getPortfolio(ownerKey);
  const current = portfolio.get(trade.code);
  if (!current) {
    return { rolledBack: false, reason: "目前沒有這檔持股可回復" };
  }

  const remainingShares = Number(current.shares) - Number(trade.shares);
  if (remainingShares < 0) {
    return { rolledBack: false, reason: "目前持股少於要回復的買進股數" };
  }

  if (remainingShares === 0) {
    await deletePortfolioPosition(ownerKey, trade.code);
    return {
      rolledBack: true,
      shares: 0,
      averageCost: 0
    };
  }

  const currentCost = Number(current.shares) * Number(current.averageCost);
  const removedCost =
    Number(trade.shares) * Number(trade.price) + Number(trade.fee || 0);
  const nextCost = Math.max(0, currentCost - removedCost);
  const nextAverageCost = Number((nextCost / remainingShares).toFixed(2));

  await savePortfolioPosition(ownerKey, trade.code, {
    shares: remainingShares,
    averageCost: nextAverageCost
  });

  return {
    rolledBack: true,
    shares: remainingShares,
    averageCost: nextAverageCost
  };
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

const getAnnualDividendYear = (dividend) => {
  if (dividend.code !== "TOTAL") {
    return null;
  }

  const note = dividend.note || "";
  const match = note.match(/(\d{4})/);
  return match ? match[1] : null;
};

const getAnnualDividends = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return (portfolioDividends.get(ownerKey) || []).filter(
      (dividend) => getAnnualDividendYear(dividend) !== null
    );
  }

  const response = await axios.get(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      code: "eq.TOTAL",
      select: "id,code,amount,note,received_at",
      order: "received_at.desc",
      limit: 100
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

const deleteAnnualDividendByYear = async (ownerKey, year) => {
  const yearText = String(year);
  const annualDividends = await getAnnualDividends(ownerKey);
  const matchedDividends = annualDividends.filter(
    (dividend) => getAnnualDividendYear(dividend) === yearText
  );

  if (matchedDividends.length === 0) {
    return [];
  }

  if (!hasPortfolioDb) {
    const dividends = portfolioDividends.get(ownerKey) || [];
    portfolioDividends.set(
      ownerKey,
      dividends.filter(
        (dividend) =>
          !(
            dividend.code === "TOTAL" &&
            getAnnualDividendYear(dividend) === yearText
          )
      )
    );
    return matchedDividends;
  }

  for (const dividend of matchedDividends) {
    await axios.delete(dividendApiUrl(), {
      headers: supabaseHeaders(),
      params: {
        owner_key: `eq.${ownerKey}`,
        id: `eq.${dividend.id}`
      }
    });
  }

  return matchedDividends;
};

const recordAnnualDividend = async (ownerKey, year, amount, note) => {
  const replaced = await deleteAnnualDividendByYear(ownerKey, year);
  await recordDividend(ownerKey, {
    code: "TOTAL",
    amount,
    note: note || `${year} 年度股利總額`
  });
  return replaced.length;
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
💾 持股備份：持股備份
📦 查看備份：持股備份查看
♻️ 還原備份：持股還原
📸 記錄快照：資產快照
📆 期間盈虧：月盈虧 / 季盈虧 / 年盈虧
🛡️ 風險控管：風險控管
⚖️ 再平衡建議：再平衡 / 再平衡 18 保守
🧮 減碼試算：再平衡試算 由田 100
🧾 買進紀錄：買進 台積電 10 2380
💸 賣出紀錄：賣出 台積電 5 2450
🧮 買賣試算：買進試算 台積電 10 2380
🧮 賣出試算：賣出試算 台積電 5 2450
💰 含費用：買進 台積電 10 2380 手續費20
💰 含稅費：賣出 台積電 5 2450 手續費20 交易稅36
📥 匯入交易：交易匯入格式
🗑️ 刪除交易：交易刪除 1
↩️ 刪除並回復買進：交易刪除回復 1
🎁 股息股利：股息 台積電 1000
🎁 年度股利：年度股利 2026 3407
📋 年度股利紀錄：年度股利紀錄
🗑️ 刪除年度股利：年度股利刪除 2026
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
const formatTradeDate = (value) => {
  if (!value) {
    return "剛剛";
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }

  return new Date(value).toLocaleDateString("zh-TW");
};

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

const taipeiDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day"))
  };
};

const dateKey = ({ year, month, day }) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const todayTaipeiDateKey = () => dateKey(taipeiDateParts());

const periodStartDateKey = (period) => {
  const now = taipeiDateParts();
  if (period === "year") {
    return dateKey({ year: now.year, month: 1, day: 1 });
  }
  if (period === "quarter") {
    const quarterStartMonth = Math.floor((now.month - 1) / 3) * 3 + 1;
    return dateKey({ year: now.year, month: quarterStartMonth, day: 1 });
  }
  return dateKey({ year: now.year, month: now.month, day: 1 });
};

const periodLabel = (period) =>
  period === "year" ? "今年" : period === "quarter" ? "本季" : "本月";

const savePortfolioValueSnapshot = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return null;
  }

  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  if (totals.successful.length === 0 || totals.totalMarket <= 0) {
    return null;
  }

  const snapshotDate = todayTaipeiDateKey();
  const row = {
    snapshotDate,
    totalCost: totals.totalCost,
    totalMarket: totals.totalMarket,
    totalProfit: totals.totalProfit,
    totalPercent: totals.totalPercent,
    positions: totals.successful.map((item) => ({
      code: item.code,
      name: item.name,
      shares: item.shares,
      averageCost: item.averageCost,
      price: item.price,
      costValue: item.costValue,
      marketValue: item.marketValue,
      profit: item.profit,
      profitPercent: item.profitPercent
    })),
    failedCount: totals.failedCount,
    createdAt: new Date().toISOString()
  };

  if (!hasPortfolioDb) {
    const rows = portfolioValueSnapshots.get(ownerKey) || [];
    const nextRows = rows.filter((item) => item.snapshotDate !== snapshotDate);
    nextRows.push(row);
    portfolioValueSnapshots.set(
      ownerKey,
      nextRows.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
    );
    return row;
  }

  await axios.post(
    `${valueSnapshotApiUrl()}?on_conflict=owner_key,snapshot_date`,
    {
      owner_key: ownerKey,
      snapshot_date: row.snapshotDate,
      total_cost: row.totalCost,
      total_market: row.totalMarket,
      total_profit: row.totalProfit,
      total_percent: row.totalPercent,
      positions: row.positions
    },
    {
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
    }
  );

  return row;
};

const getPortfolioValueSnapshots = async (ownerKey, startDate, endDate) => {
  if (!hasPortfolioDb) {
    return (portfolioValueSnapshots.get(ownerKey) || []).filter(
      (row) => row.snapshotDate >= startDate && row.snapshotDate <= endDate
    );
  }

  const response = await axios.get(valueSnapshotApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      snapshot_date: `gte.${startDate}`,
      snapshot_date_lte: `lte.${endDate}`,
      select:
        "snapshot_date,total_cost,total_market,total_profit,total_percent,positions,created_at",
      order: "snapshot_date.asc"
    },
    paramsSerializer: (params) =>
      Object.entries(params)
        .map(([key, value]) => {
          const paramKey = key === "snapshot_date_lte" ? "snapshot_date" : key;
          return `${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`;
        })
        .join("&")
  });

  return (response.data || []).map((row) => ({
    snapshotDate: row.snapshot_date,
    totalCost: Number(row.total_cost),
    totalMarket: Number(row.total_market),
    totalProfit: Number(row.total_profit),
    totalPercent: Number(row.total_percent),
    positions: Array.isArray(row.positions) ? row.positions : [],
    createdAt: row.created_at
  }));
};

const buildPortfolioPeriodReport = async (ownerKey, period) => {
  const latestSnapshot = await savePortfolioValueSnapshot(ownerKey);
  if (!latestSnapshot) {
    return "目前沒有可記錄的持股快照，可能是沒有持股或即時報價查詢失敗。";
  }

  const startDate = periodStartDateKey(period);
  const endDate = todayTaipeiDateKey();
  const rows = await getPortfolioValueSnapshots(ownerKey, startDate, endDate);
  if (rows.length < 2) {
    return `📆 ${periodLabel(period)}持股盈虧

已記錄今日快照：${latestSnapshot.snapshotDate}
目前總市值：${formatMoney(latestSnapshot.totalMarket)} 元
目前總成本：${formatMoney(latestSnapshot.totalCost)} 元
目前未實現損益：${profitSign(latestSnapshot.totalProfit)}${formatMoney(
      latestSnapshot.totalProfit
    )} 元（${profitSign(latestSnapshot.totalPercent)}${formatPercent(
      latestSnapshot.totalPercent
    )}%）

目前期間內只有 ${rows.length} 筆快照。
月/季/年盈虧需要至少 2 個不同日期的快照才可比較。

之後每天可輸入「資產快照」或查「月盈虧」自動更新。`;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const marketChange = last.totalMarket - first.totalMarket;
  const costChange = last.totalCost - first.totalCost;
  const profitChange = last.totalProfit - first.totalProfit;
  const percentPointChange = last.totalPercent - first.totalPercent;
  const marketChangePercent =
    first.totalMarket > 0 ? (marketChange / first.totalMarket) * 100 : 0;
  const strongest = [...(last.positions || [])]
    .sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0))
    .slice(0, 3)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name || stockNames[item.code] || item.code}（${
          item.code
        }）：${profitSign(item.profit)}${formatMoney(item.profit)} 元`
    )
    .join("\n");
  const weakest = [...(last.positions || [])]
    .sort((a, b) => Number(a.profit || 0) - Number(b.profit || 0))
    .slice(0, 3)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name || stockNames[item.code] || item.code}（${
          item.code
        }）：${profitSign(item.profit)}${formatMoney(item.profit)} 元`
    )
    .join("\n");

  return `📆 ${periodLabel(period)}持股盈虧

期間：${first.snapshotDate} → ${last.snapshotDate}
快照筆數：${rows.length} 筆

總市值：
${formatMoney(first.totalMarket)} → ${formatMoney(last.totalMarket)} 元
變化：${profitSign(marketChange)}${formatMoney(marketChange)} 元（${profitSign(
    marketChangePercent
  )}${formatPercent(marketChangePercent)}%）

總成本變化：${profitSign(costChange)}${formatMoney(costChange)} 元
未實現損益變化：${profitSign(profitChange)}${formatMoney(profitChange)} 元
報酬率變化：${profitSign(percentPointChange)}${formatPercent(
    percentPointChange
  )} 個百分點

目前賺最多：
${strongest || "暫無資料"}

目前拖累最多：
${weakest || "暫無資料"}

提醒：這是資產快照比較，會受新增持股、減碼、股價變動共同影響。`;
};

if (userMessage.trim() === "資產快照" || userMessage.trim() === "持股快照") {
  const snapshot = await savePortfolioValueSnapshot(watchlistKey);
  if (!snapshot) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前無法建立資產快照，可能是沒有持股或即時報價查詢失敗。"
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📸 已記錄資產快照
日期：${snapshot.snapshotDate}
總市值：${formatMoney(snapshot.totalMarket)} 元
總成本：${formatMoney(snapshot.totalCost)} 元
未實現損益：${profitSign(snapshot.totalProfit)}${formatMoney(
      snapshot.totalProfit
    )} 元（${profitSign(snapshot.totalPercent)}${formatPercent(
      snapshot.totalPercent
    )}%）${
      snapshot.failedCount > 0
        ? `\n\n提醒：${snapshot.failedCount} 檔報價失敗，未列入快照。`
        : ""
    }`
  });
}

const periodProfitMap = {
  月盈虧: "month",
  持股月盈虧: "month",
  季盈虧: "quarter",
  持股季盈虧: "quarter",
  年盈虧: "year",
  持股年盈虧: "year"
};
if (periodProfitMap[userMessage.trim()]) {
  const text = await buildPortfolioPeriodReport(
    watchlistKey,
    periodProfitMap[userMessage.trim()]
  );
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

if (userMessage.trim() === "持股備份") {
  const backup = await savePortfolioBackup(watchlistKey);
  if (!backup) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股可備份。請先輸入「匯入持股」或「持股+台積電 35 2000」。"
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `💾 已建立持股備份
持股檔數：${backup.rows.length} 檔
備份時間：${new Date(backup.savedAt).toLocaleString("zh-TW")}

之後若測試改亂，可輸入「持股還原」。`
  });
}

if (userMessage.trim() === "持股備份查看" || userMessage.trim() === "查看持股備份") {
  const backup = await getPortfolioBackup(watchlistKey);
  if (!backup) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股備份。可輸入「持股備份」建立一份。"
    });
  }

  const rows = backup.rows
    .slice(0, 12)
    .map(
      (row, index) =>
        `${index + 1}. ${stockNames[row.code] || row.code}（${row.code}）：${
          row.shares
        } 股｜成本 ${row.averageCost} 元`
    );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📦 持股備份
備份時間：${new Date(backup.savedAt).toLocaleString("zh-TW")}
持股檔數：${backup.rows.length} 檔

${rows.join("\n")}${
      backup.rows.length > 12 ? `\n...另有 ${backup.rows.length - 12} 檔` : ""
    }`
  });
}

if (userMessage.trim() === "持股還原") {
  const restored = await restorePortfolioBackup(watchlistKey);
  if (!restored) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有可還原的持股備份。請先輸入「持股備份」。"
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `♻️ 已還原持股備份
還原檔數：${restored.portfolio.size} 檔
備份時間：${new Date(restored.savedAt).toLocaleString("zh-TW")}

輸入「我的持股」可確認最新持股。`
  });
}

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

if (userMessage.trim() === "交易匯入格式") {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📥 批次匯入交易格式

第一行輸入：匯入交易
第二行開始每行一筆：
日期 買進/賣出 代號 股數 價格 手續費 交易稅

範例：
匯入交易
2026-06-03 買進 2353 300 42.5 18 0
2026-06-02 賣出 2409 1000 25 36 75

提醒：這只匯入交易歷史，不會改目前持股。`
  });
}

const tradeImportMatch = userMessage.trim().match(/^匯入交易\s*\n([\s\S]+)$/);
if (tradeImportMatch) {
  const lines = tradeImportMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入「交易匯入格式」查看範例。"
    });
  }

  const saved = [];
  const failed = [];

  for (const [lineIndex, line] of lines.entries()) {
    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      failed.push(`${lineIndex + 1}. 欄位不足：${line}`);
      continue;
    }

    const tradedAt = parseHistoricalTradeDate(parts[0]);
    const type = parseTradeTypeToken(parts[1]);
    const code = resolveStockCode(parts[2]);
    const shares = parseNumberToken(parts[3]);
    const price = parseNumberToken(parts[4]);
    const amount = shares * price;
    const fee =
      parts[5] !== undefined
        ? parseNumberToken(parts[5])
        : type === "sell"
        ? estimateSellFee(amount)
        : estimateBuyFee(amount);
    const tax =
      parts[6] !== undefined
        ? parseNumberToken(parts[6])
        : type === "sell"
        ? estimateSellTax(amount)
        : 0;
    const realizedProfit =
      parts[7] !== undefined ? parseNumberToken(parts[7]) : 0;

    if (
      !tradedAt ||
      !type ||
      !/^\d{4,6}$/.test(code) ||
      !Number.isFinite(shares) ||
      !Number.isFinite(price) ||
      !Number.isFinite(fee) ||
      !Number.isFinite(tax) ||
      !Number.isFinite(realizedProfit) ||
      shares <= 0 ||
      price <= 0 ||
      fee < 0 ||
      tax < 0
    ) {
      failed.push(`${lineIndex + 1}. 格式錯誤：${line}`);
      continue;
    }

    await recordTrade(watchlistKey, {
      code,
      type,
      shares,
      price,
      fee,
      tax,
      realizedProfit,
      tradedAt
    });

    const typeLabel = type === "buy" ? "買進" : "賣出";
    saved.push(
      `${parts[0]} ${typeLabel} ${stockNames[code] || code}（${code}）${formatMoney(
        shares
      )} 股`
    );
  }

  const savedText =
    saved.length > 0
      ? saved.slice(0, 8).join("\n") +
        (saved.length > 8 ? `\n...另 ${saved.length - 8} 筆` : "")
      : "無";
  const failedText =
    failed.length > 0
      ? `\n\n未匯入：${failed.length} 筆\n${failed.slice(0, 5).join("\n")}`
      : "";

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📥 已匯入交易紀錄：${saved.length} 筆

${savedText}
${failedText}

提醒：這只補交易歷史，不會改目前持股。
輸入「交易紀錄」可查看最新交易。`
  });
}

const buyTrialMatch = userMessage
  .trim()
  .match(/^(買進試算|試算買進)\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+.*)?$/);
if (buyTrialMatch) {
  const code = resolveStockCode(buyTrialMatch[2]);
  const buyShares = Number(buyTrialMatch[3]);
  const buyPrice = Number(buyTrialMatch[4]);
  const buyAmount = buyShares * buyPrice;
  const fee = parseOptionalMoney(userMessage, "手續費") ?? estimateBuyFee(buyAmount);

  if (!/^\d{4,6}$/.test(code) || buyShares <= 0 || buyPrice <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：買進試算 台積電 10 2380"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const current = portfolio.get(code) || { shares: 0, averageCost: 0 };
  const newShares = Number(current.shares) + buyShares;
  const newAverageCost =
    newShares > 0
      ? (Number(current.shares) * Number(current.averageCost) + buyAmount + fee) /
        newShares
      : buyPrice;
  const totalPay = buyAmount + fee;
  const averageCostChange = newAverageCost - Number(current.averageCost || 0);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧮 買進前試算：${stockNames[code] || code}（${code}）

試算買進：${formatMoney(buyShares)} 股
試算價格：${buyPrice} 元
成交金額：${formatMoney(buyAmount)} 元
手續費：${formatMoney(fee)} 元
預估支出：${formatMoney(totalPay)} 元

目前持股：${formatMoney(current.shares || 0)} 股
目前平均成本：${Number(current.averageCost || 0).toFixed(2)} 元
試算後持股：${formatMoney(newShares)} 股
試算後平均成本：${newAverageCost.toFixed(2)} 元
成本變化：${profitSign(averageCostChange)}${averageCostChange.toFixed(2)} 元

提醒：這只是試算，不會寫入持股或交易紀錄。`
  });
}

const sellTrialMatch = userMessage
  .trim()
  .match(/^(賣出試算|試算賣出)\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+.*)?$/);
if (sellTrialMatch) {
  const code = resolveStockCode(sellTrialMatch[2]);
  const sellShares = Number(sellTrialMatch[3]);
  const sellPrice = Number(sellTrialMatch[4]);
  const sellAmount = sellShares * sellPrice;
  const fee = parseOptionalMoney(userMessage, "手續費") ?? estimateSellFee(sellAmount);
  const tax = parseOptionalMoney(userMessage, "交易稅") ?? estimateSellTax(sellAmount);

  if (!/^\d{4,6}$/.test(code) || sellShares <= 0 || sellPrice <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：賣出試算 台積電 5 2450"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const current = portfolio.get(code);
  if (!current || Number(current.shares) < sellShares) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `試算失敗：${stockNames[code] || code}（${code}）目前持股不足。`
    });
  }

  const costBasis = Number(current.averageCost) * sellShares;
  const realizedProfit = sellAmount - costBasis - fee - tax;
  const netReceive = sellAmount - fee - tax;
  const remainingShares = Number(current.shares) - sellShares;
  const profitPercent = costBasis > 0 ? (realizedProfit / costBasis) * 100 : 0;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧮 賣出前試算：${stockNames[code] || code}（${code}）

試算賣出：${formatMoney(sellShares)} 股
試算價格：${sellPrice} 元
成交金額：${formatMoney(sellAmount)} 元
手續費：${formatMoney(fee)} 元
交易稅：${formatMoney(tax)} 元
預估入帳：${formatMoney(netReceive)} 元

目前持股：${formatMoney(current.shares)} 股
平均成本：${Number(current.averageCost).toFixed(2)} 元
賣出成本：${formatMoney(costBasis)} 元
試算損益：${profitSign(realizedProfit)}${formatMoney(realizedProfit)} 元（${profitSign(
      profitPercent
    )}${formatPercent(profitPercent)}%）
剩餘持股：${formatMoney(remainingShares)} 股

提醒：這只是試算，不會寫入持股或交易紀錄。`
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

const tradeDeleteRollbackMatch = userMessage
  .trim()
  .match(/^交易刪除回復\s*(\d+)$/);
if (tradeDeleteRollbackMatch) {
  const index = Number(tradeDeleteRollbackMatch[1]);
  const trades = await getTrades(watchlistKey);
  const trade = trades[index - 1];
  if (!trade) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `找不到第 ${index} 筆交易紀錄。\n請先輸入「交易紀錄」確認序號。`
    });
  }

  if (trade.type !== "buy") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前只支援買進交易的持股回復。\n賣出交易請用「交易刪除 1」只刪紀錄，再手動調整持股。"
    });
  }

  const rollback = await rollbackBuyTradePosition(watchlistKey, trade);
  if (!rollback.rolledBack) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `無法回復持股：${rollback.reason}\n交易紀錄尚未刪除。`
    });
  }

  await deleteTradeAt(watchlistKey, index);

  const holdingText =
    rollback.shares > 0
      ? `目前持股：${formatMoney(rollback.shares)} 股\n新平均成本：${rollback.averageCost} 元`
      : "目前持股：已歸零，已移除此檔持股";

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `↩️ 已刪除交易並回復持股
第 ${index} 筆：買進 ${stockNames[trade.code] || trade.code}（${trade.code}）
回復股數：${formatMoney(trade.shares)} 股
原買進價格：${trade.price} 元
手續費：${formatMoney(trade.fee || 0)} 元

${holdingText}

輸入「我的持股」可確認最新持股。`
  });
}

const tradeDeleteMatch = userMessage
  .trim()
  .match(/^交易刪除(?!回復)\s*(\d+)$/);
if (tradeDeleteMatch) {
  const index = Number(tradeDeleteMatch[1]);
  const trade = await deleteTradeAt(watchlistKey, index);
  if (!trade) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `找不到第 ${index} 筆交易紀錄。\n請先輸入「交易紀錄」確認序號。`
    });
  }

  const typeLabel = trade.type === "buy" ? "買進" : "賣出";
  const realized =
    trade.type === "sell"
      ? `\n已實現損益：${profitSign(trade.realizedProfit)}${formatMoney(
          trade.realizedProfit
        )} 元`
      : "";

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已刪除交易紀錄
第 ${index} 筆：${typeLabel} ${stockNames[trade.code] || trade.code}（${trade.code}）
股數：${formatMoney(trade.shares)} 股
價格：${trade.price} 元
手續費：${formatMoney(trade.fee || 0)} 元
交易稅：${formatMoney(trade.tax || 0)} 元${realized}

提醒：這只刪除交易歷史，不會自動回復持股股數。
輸入「交易紀錄」可確認最新列表。`
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
      const date = formatTradeDate(trade.tradedAt);

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

const dividendMatch = userMessage
  .trim()
  .match(/^(股息|股利)(?!刪除)\s+(\S+)\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
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

if (userMessage.trim() === "年度股利紀錄" || userMessage.trim() === "年度股利列表") {
  const annualDividends = await getAnnualDividends(watchlistKey);
  if (annualDividends.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有年度股利紀錄。可輸入：年度股利 2026 3407"
    });
  }

  const rows = annualDividends
    .map((dividend) => ({
      ...dividend,
      year: getAnnualDividendYear(dividend)
    }))
    .filter((dividend) => dividend.year)
    .sort((a, b) => Number(b.year) - Number(a.year))
    .map(
      (dividend) =>
        `${dividend.year}：${formatMoney(dividend.amount)} 元`
    );
  const total = annualDividends.reduce(
    (sum, dividend) => sum + Number(dividend.amount || 0),
    0
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 年度股利紀錄

${rows.join("\n")}

年度股利合計：${formatMoney(total)} 元

要刪除某年可輸入：年度股利刪除 2026`
  });
}

const annualDividendDeleteMatch = userMessage
  .trim()
  .match(/^年度股利刪除\s*(\d{4})$/);
if (annualDividendDeleteMatch) {
  const year = annualDividendDeleteMatch[1];
  const deleted = await deleteAnnualDividendByYear(watchlistKey, year);
  if (deleted.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `找不到 ${year} 年度股利紀錄。\n請先輸入「年度股利紀錄」確認。`
    });
  }

  const deletedTotal = deleted.reduce(
    (sum, dividend) => sum + Number(dividend.amount || 0),
    0
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已刪除 ${year} 年度股利
刪除筆數：${deleted.length}
金額合計：${formatMoney(deletedTotal)} 元

輸入「年度股利紀錄」可確認最新年度股利。`
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

    const replacedCount = await recordAnnualDividend(watchlistKey, year, amount, note);
    savedRows.push(
      `${year}：${formatMoney(amount)} 元${
        replacedCount > 0 ? `（已覆蓋舊資料 ${replacedCount} 筆）` : ""
      }`
    );
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

  const replacedCount = await recordAnnualDividend(
    watchlistKey,
    year,
    amount,
    note
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎁 已${replacedCount > 0 ? "更新" : "記錄"}年度股利
年度：${year}
金額：${formatMoney(amount)} 元
備註：${note}${
      replacedCount > 0 ? `\n已覆蓋舊資料：${replacedCount} 筆` : ""
    }`
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

if (userMessage.trim() === "風險控管" || userMessage.trim() === "持股風險") {
  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法做風險控管。請先輸入「匯入持股」建立資料。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  if (totals.successful.length === 0 || totals.totalMarket <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前即時報價查詢失敗，暫時無法計算風險控管。請稍後再試。"
    });
  }

  const withWeight = totals.successful
    .map((item) => ({
      ...item,
      weight: (item.marketValue / totals.totalMarket) * 100
    }))
    .sort((a, b) => b.weight - a.weight);
  const topWeights = withWeight
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${formatPercent(item.weight)}%`
    )
    .join("\n");
  const overweight = withWeight
    .filter((item) => item.weight >= 20)
    .map((item) => `${item.name}（${item.code}）${formatPercent(item.weight)}%`);
  const watchWeight = withWeight
    .filter((item) => item.weight >= 15 && item.weight < 20)
    .map((item) => `${item.name}（${item.code}）${formatPercent(item.weight)}%`);
  const deepLosses = totals.successful
    .filter((item) => item.profitPercent <= -30)
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .map(
      (item) =>
        `${item.name}（${item.code}）：${profitSign(item.profitPercent)}${formatPercent(
          item.profitPercent
        )}%`
    );
  const mildLosses = totals.successful
    .filter((item) => item.profitPercent <= -10 && item.profitPercent > -30)
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 5)
    .map(
      (item) =>
        `${item.name}（${item.code}）：${profitSign(item.profitPercent)}${formatPercent(
          item.profitPercent
        )}%`
    );
  const riskScore =
    Math.min(40, overweight.length * 15 + watchWeight.length * 8) +
    Math.min(40, deepLosses.length * 15 + mildLosses.length * 6) +
    (totals.totalPercent < 0 ? 20 : totals.totalPercent < 5 ? 10 : 0);
  const riskLevel =
    riskScore >= 70 ? "高" : riskScore >= 40 ? "中" : "低";
  const suggestions = [];
  if (overweight.length > 0) {
    suggestions.push("單一持股超過 20%，後續加碼前先檢查是否過度集中。");
  }
  if (deepLosses.length > 0) {
    suggestions.push("有持股虧損超過 30%，建議重新檢查持股理由與停損計畫。");
  }
  if (totals.totalPercent > 10 && deepLosses.length > 0) {
    suggestions.push("整體仍獲利但弱勢股拖累明顯，可分開檢視強勢股與虧損股。");
  }
  if (suggestions.length === 0) {
    suggestions.push("目前風險結構相對穩定，持續追蹤集中度與重大虧損即可。");
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🛡️ 投資組合風險控管

風險等級：${riskLevel}
持股檔數：${entries.length} 檔
總市值：${formatMoney(totals.totalMarket)} 元
未實現報酬率：${profitSign(totals.totalPercent)}${formatPercent(
      totals.totalPercent
    )}%

前五大持股比重：
${topWeights}

集中度提醒：
${overweight.length > 0 ? overweight.join("\n") : "無單檔超過 20%"}
${watchWeight.length > 0 ? `\n\n接近偏高：\n${watchWeight.join("\n")}` : ""}

虧損風險：
${deepLosses.length > 0 ? deepLosses.join("\n") : "無持股虧損超過 30%"}
${mildLosses.length > 0 ? `\n\n虧損 10%～30%：\n${mildLosses.join("\n")}` : ""}

建議：
${suggestions.map((item, index) => `${index + 1}. ${item}`).join("\n")}${
      totals.failedCount > 0
        ? `\n\n提醒：${totals.failedCount} 檔即時報價查詢失敗，未列入風險計算。`
        : ""
    }`
  });
}

const rebalanceTrialMatch = userMessage
  .trim()
  .match(/^再平衡試算\s+(\S+)\s+(\d+(?:\.\d+)?)$/);
if (rebalanceTrialMatch) {
  const code = resolveStockCode(rebalanceTrialMatch[1]);
  const reduceShares = Number(rebalanceTrialMatch[2]);
  if (!/^\d{4,6}$/.test(code) || reduceShares <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：再平衡試算 由田 100"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const position = portfolio.get(code);
  if (!position) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `目前沒有 ${stockNames[code] || code}（${code}）這檔持股。`
    });
  }
  if (reduceShares >= Number(position.shares)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `試算股數不可大於或等於目前持股。\n目前持有：${formatMoney(
        position.shares
      )} 股`
    });
  }

  const entries = [...portfolio.entries()];
  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  const target = totals.successful.find((item) => item.code === code);
  if (!target || totals.totalMarket <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前即時報價查詢失敗，暫時無法試算。請稍後再試。"
    });
  }

  const reduceValue = reduceShares * target.price;
  const newTotalMarket = totals.totalMarket - reduceValue;
  const newTargetShares = Number(position.shares) - reduceShares;
  const newTargetMarketValue = target.marketValue - reduceValue;
  const oldWeight = (target.marketValue / totals.totalMarket) * 100;
  const newWeight =
    newTotalMarket > 0 ? (newTargetMarketValue / newTotalMarket) * 100 : 0;
  const adjustedWeights = totals.successful
    .map((item) => {
      const marketValue =
        item.code === code ? newTargetMarketValue : item.marketValue;
      return {
        ...item,
        marketValue,
        weight: newTotalMarket > 0 ? (marketValue / newTotalMarket) * 100 : 0
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${formatPercent(item.weight)}%`
    )
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧮 再平衡減碼試算

標的：${target.name}（${target.code}）
目前持有：${formatMoney(position.shares)} 股
試算減碼：${formatMoney(reduceShares)} 股
試算成交價：${target.price} 元
約釋出資金：${formatMoney(reduceValue)} 元

比重變化：
${formatPercent(oldWeight)}% → ${formatPercent(newWeight)}%
剩餘股數：${formatMoney(newTargetShares)} 股
試算後總市值：${formatMoney(newTotalMarket)} 元

試算後前五大：
${adjustedWeights}

提醒：這只是試算，不會修改持股或交易紀錄。`
  });
}

const rebalanceMatch = userMessage.trim().match(/^再平衡(?:\s+(.+))?$/);
if (rebalanceMatch) {
  const args = (rebalanceMatch[1] || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const numberArg = args.find((item) => /^\d+(?:\.\d+)?$/.test(item));
  const modeArg = args.find((item) => item === "保守" || item === "積極") || "標準";
  const maxWeight = numberArg ? Number(numberArg) : 20;
  const allowedArgs = args.every(
    (item) => /^\d+(?:\.\d+)?$/.test(item) || item === "保守" || item === "積極"
  );
  if (!allowedArgs) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：再平衡、再平衡 18、再平衡 18 保守"
    });
  }
  if (maxWeight < 5 || maxWeight > 50) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目標上限請輸入 5～50 之間，例如：再平衡 18"
    });
  }

  const portfolio = await getPortfolio(watchlistKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法產生再平衡建議。請先輸入「匯入持股」建立資料。"
    });
  }

  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  if (totals.successful.length === 0 || totals.totalMarket <= 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前即時報價查詢失敗，暫時無法產生再平衡建議。請稍後再試。"
    });
  }

  const withWeight = totals.successful
    .map((item) => ({
      ...item,
      weight: (item.marketValue / totals.totalMarket) * 100
    }))
    .sort((a, b) => b.weight - a.weight);
  const overweight = withWeight
    .filter((item) => item.weight > maxWeight)
    .map((item) => {
      const targetMarketValue = totals.totalMarket * (maxWeight / 100);
      const excessValue = item.marketValue - targetMarketValue;
      const excessShares =
        item.price > 0 ? Math.max(0, Math.floor(excessValue / item.price)) : 0;
      return {
        ...item,
        excessValue,
        excessShares
      };
    });
  const candidateMaxWeight = Math.max(5, maxWeight * 0.6);
  const addCandidates = withWeight
    .filter((item) => {
      if (item.weight >= candidateMaxWeight) {
        return false;
      }
      if (modeArg === "保守") {
        return item.profitPercent >= 0;
      }
      if (modeArg === "積極") {
        return item.profitPercent > -10;
      }
      return item.profitPercent > -30;
    })
    .slice(0, 5);
  const avoidAveraging = withWeight
    .filter((item) => item.profitPercent <= -30)
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 5);
  const topWeights = withWeight
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name}（${item.code}）：${formatPercent(item.weight)}%`
    )
    .join("\n");
  const overweightText =
    overweight.length > 0
      ? overweight
          .map(
            (item, index) =>
              `${index + 1}. ${item.name}（${item.code}）：${formatPercent(
                item.weight
              )}% → 目標 ${formatPercent(maxWeight)}%，超出約 ${formatMoney(
                item.excessValue
              )} 元${item.excessShares > 0 ? `（約 ${item.excessShares} 股）` : ""}`
          )
          .join("\n")
      : `沒有持股超過 ${formatPercent(maxWeight)}%。`;
  const addCandidateText =
    addCandidates.length > 0
      ? addCandidates
          .map(
            (item, index) =>
              `${index + 1}. ${item.name}（${item.code}）：目前 ${formatPercent(
                item.weight
              )}%，報酬 ${profitSign(item.profitPercent)}${formatPercent(
                item.profitPercent
              )}%`
          )
          .join("\n")
      : "目前沒有明顯低比重且未重虧的候選。";
  const avoidText =
    avoidAveraging.length > 0
      ? avoidAveraging
          .map(
            (item, index) =>
              `${index + 1}. ${item.name}（${item.code}）：${profitSign(
                item.profitPercent
              )}${formatPercent(item.profitPercent)}%`
          )
          .join("\n")
      : "沒有持股虧損超過 30%。";
  const modeSuggestion =
    modeArg === "保守"
      ? "保守模式：只把獲利或至少不虧損的低比重部位列為補比重候選。"
      : modeArg === "積極"
      ? "積極模式：允許觀察小幅虧損但未重虧的低比重部位。"
      : "標準模式：避開重虧股，優先觀察低比重且未嚴重轉弱的部位。";
  const suggestions = [
    `單檔上限先抓 ${formatPercent(maxWeight)}%，超標部位暫停加碼。`,
    modeSuggestion,
    "高虧損股先檢查基本面與停損計畫，不把攤平當第一反應。"
  ];

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `⚖️ 投組再平衡建議

目標單檔上限：${formatPercent(maxWeight)}%
模式：${modeArg}
持股檔數：${entries.length} 檔
總市值：${formatMoney(totals.totalMarket)} 元
未實現報酬率：${profitSign(totals.totalPercent)}${formatPercent(
      totals.totalPercent
    )}%

目前前五大：
${topWeights}

超過目標上限：
${overweightText}

可觀察補比重候選：
${addCandidateText}

避免直接攤平：
${avoidText}

建議：
${suggestions.map((item, index) => `${index + 1}. ${item}`).join("\n")}${
      totals.failedCount > 0
        ? `\n\n提醒：${totals.failedCount} 檔即時報價查詢失敗，未列入再平衡計算。`
        : ""
    }

提醒：以上為比重試算，不是買賣建議。`
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
