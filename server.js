const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();
const BOT_BUILD_VERSION = "2026-07-07 BUTLER-GEMINI-3";

// =================【1. LINE & OpenAI 設定】=================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
let openaiClient;
const getOpenAIClient = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
};
const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
const watchlists = new Map();
const portfolios = new Map();
const portfolioTrades = new Map();
const portfolioDividends = new Map();
const priceAlerts = new Map();
const tieredCostAlerts = new Map();
const portfolioBackups = new Map();
const portfolioValueSnapshots = new Map();
const quoteCache = new Map();
let tdccShareholdingCache = { fetchedAt: 0, rowsByCode: new Map(), sourceDate: null };
const intradayBriefPushLog = new Set();
const intradayAnalysisPushLog = new Set();
const intradayAnomalyBaselines = new Map();
const intradayAnomalyPushLog = new Map();
const intradayAnomalySettings = new Map();
const dailyReportPushLog = new Set();
const dailyReportSettings = new Map();
const dailyChipMovementPushLog = new Set();
const linePushCooldownLog = new Map();
const lineAgentInteractionMemory = new Map();
const lineButlerLifeMemory = new Map();
const lineButlerReminders = new Map();
const lineButlerCloudLoaded = new Set();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const hasPortfolioDb = Boolean(SUPABASE_URL && SUPABASE_KEY);
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const hasCloudState = Boolean(JSONBIN_API_KEY && JSONBIN_BIN_ID);
const AI_DASHBOARD_BASE_URL =
  (process.env.AI_DASHBOARD_BASE_URL || "http://49.159.84.162:8050").replace(/\/$/, "");
const AI_DASHBOARD_CACHE_TTL_MS =
  Number(process.env.AI_DASHBOARD_CACHE_TTL_MS || 10 * 60 * 1000);
const aiDashboardSummaryCache = new Map();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_BASE_URL =
  (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

const jsonBinUrl = (suffix = "") =>
  `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}${suffix}`;

const jsonBinHeaders = (extra = {}) => ({
  "X-Master-Key": JSONBIN_API_KEY,
  "X-Bin-Meta": "false",
  ...extra
});

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal"
});

const serviceErrorMessage = (error) => {
  const detail = error?.response?.data;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (detail && typeof detail === "object") {
    return [detail.message, detail.details, detail.hint, detail.code]
      .filter(Boolean)
      .join("｜");
  }
  return error?.message || "未知錯誤";
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeDashboardSymbol = (symbol) => {
  const normalized = String(symbol || "").trim().toUpperCase();
  return /^[0-9A-Z]{2,12}$/.test(normalized) ? normalized : "";
};

const compactAiDashboardSummary = (data, symbol) => {
  const panel12 = data?.panel12 || {};
  const panel2 = data?.panel2 || {};
  const panel3 = data?.panel3 || {};
  const panel8 = data?.panel8 || {};
  const panel10 = data?.panel10 || {};
  const scenario =
    Array.isArray(panel10.scenarios) && panel10.scenarios.length
      ? panel10.scenarios.find((item) => item?.tone === "base") || panel10.scenarios[0]
      : null;
  const projectedPrice =
    Array.isArray(scenario?.prices) && scenario.prices.length
      ? toFiniteNumber(scenario.prices[scenario.prices.length - 1])
      : null;

  return {
    ok: true,
    symbol,
    name: data?.meta?.name || "",
    updatedAt: data?.meta?.updated_at || null,
    dashboardUrl: `${AI_DASHBOARD_BASE_URL}/?symbol=${encodeURIComponent(symbol)}`,
    price: toFiniteNumber(data?.ticker?.price),
    changeRate: toFiniteNumber(data?.ticker?.change_rate),
    signal: panel12.signal || "",
    headline: panel12.headline || "",
    confidence: toFiniteNumber(panel12.confidence),
    risk: toFiniteNumber(panel12.risk),
    riskLevel: panel12.risk_level || "",
    strategy: panel12.strategy || "",
    target: Array.isArray(panel12.targets) ? toFiniteNumber(panel12.targets[0]) : null,
    stop: toFiniteNumber(panel12.stop),
    daytradeAdvice: panel2.daytrade_advice || "",
    daytradeRisk: toFiniteNumber(panel2.risk),
    chipRank: panel3.rank || "",
    chipScore: toFiniteNumber(panel3.score),
    health: panel8.summary || "",
    projection: projectedPrice,
    dataQuality: toFiniteNumber(data?.meta?.data_quality)
  };
};

const portfolioApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_positions`;

const tradeApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_trades`;

const dividendApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_dividends`;

const alertApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/price_alerts`;

const tieredCostAlertApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/cost_band_alerts`;

const backupApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_backups`;

const valueSnapshotApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/portfolio_value_snapshots`;

const dailyReportSettingApiUrl = () =>
  `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/daily_report_settings`;

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
const LINE_STOCK_PUSH_ENABLED =
  process.env.LINE_STOCK_PUSH_ENABLED === "true";
const ALERT_CHECK_INTERVAL_MS =
  Number(process.env.ALERT_CHECK_INTERVAL_MS) || 10 * 60 * 1000;
const INTRADAY_PUSH_INTERVAL_MS =
  Number(process.env.INTRADAY_PUSH_INTERVAL_MS) || 60 * 1000;
const INTRADAY_PUSH_TIMES = (process.env.INTRADAY_PUSH_TIMES || "10:00,12:30,13:20")
  .split(",")
  .map((time) => time.trim())
  .filter(Boolean);
const INTRADAY_PUSH_ENABLED = process.env.INTRADAY_PUSH_ENABLED !== "false";
const INTRADAY_ANALYSIS_TIMES = (process.env.INTRADAY_ANALYSIS_TIMES || "10:00,12:50")
  .split(",")
  .map((time) => time.trim())
  .filter(Boolean);
const INTRADAY_ANALYSIS_ENABLED =
  process.env.INTRADAY_ANALYSIS_ENABLED !== "false";
const INTRADAY_ANOMALY_ENABLED =
  process.env.INTRADAY_ANOMALY_ENABLED !== "false";
const INTRADAY_ANOMALY_INTERVAL_MS =
  Number(process.env.INTRADAY_ANOMALY_INTERVAL_MS) || 5 * 60 * 1000;
const INTRADAY_ANOMALY_COOLDOWN_MS =
  Number(process.env.INTRADAY_ANOMALY_COOLDOWN_MS) || 30 * 60 * 1000;
const INTRADAY_STOCK_MOVE_PERCENT =
  Number(process.env.INTRADAY_STOCK_MOVE_PERCENT) || 5;
const INTRADAY_STOCK_PROFIT_DELTA =
  Number(process.env.INTRADAY_STOCK_PROFIT_DELTA) || 5000;
const INTRADAY_TOTAL_PROFIT_DELTA =
  Number(process.env.INTRADAY_TOTAL_PROFIT_DELTA) || 10000;
const DAILY_REPORT_INTERVAL_MS =
  Number(process.env.DAILY_REPORT_INTERVAL_MS) || 60 * 1000;
const DAILY_REPORT_TIMES = (process.env.DAILY_REPORT_TIMES || "14:35")
  .split(",")
  .map((time) => time.trim())
  .filter(Boolean);
const DAILY_REPORT_ENABLED = process.env.DAILY_REPORT_ENABLED !== "false";
const DAILY_REPORT_MODE = (process.env.DAILY_REPORT_MODE || "compact").toLowerCase();
const DAILY_CHIP_MOVEMENT_TIMES = (process.env.DAILY_CHIP_MOVEMENT_TIMES || "15:10")
  .split(",")
  .map((time) => time.trim())
  .filter(Boolean);
const DAILY_CHIP_MOVEMENT_ENABLED =
  process.env.DAILY_CHIP_MOVEMENT_ENABLED !== "false";
const LINE_SCHEDULED_PUSH_MIN_GAP_MS =
  Number(process.env.LINE_SCHEDULED_PUSH_MIN_GAP_MS) || 60 * 60 * 1000;
const LINE_ALERT_PUSH_MIN_GAP_MS =
  Number(process.env.LINE_ALERT_PUSH_MIN_GAP_MS) || 90 * 60 * 1000;

const shouldSkipLinePush = (ownerKey, group, minGapMs, force = false) => {
  if (force || !minGapMs) return false;
  const key = `${group}|${ownerKey}`;
  const lastPushedAt = linePushCooldownLog.get(key) || 0;
  return Date.now() - lastPushedAt < minGapMs;
};

const markLinePush = (ownerKey, group) => {
  linePushCooldownLog.set(`${group}|${ownerKey}`, Date.now());
};

const defaultIntradayAnomalySettings = () => ({
  stockMovePercent: INTRADAY_STOCK_MOVE_PERCENT,
  stockProfitDelta: INTRADAY_STOCK_PROFIT_DELTA,
  totalProfitDelta: INTRADAY_TOTAL_PROFIT_DELTA
});

const getIntradayAnomalySettings = (ownerKey) =>
  intradayAnomalySettings.get(ownerKey) || defaultIntradayAnomalySettings();

const saveIntradayAnomalySettings = (ownerKey, settings) => {
  intradayAnomalySettings.set(ownerKey, {
    stockMovePercent: Number(settings.stockMovePercent),
    stockProfitDelta: Number(settings.stockProfitDelta),
    totalProfitDelta: Number(settings.totalProfitDelta)
  });
};

const normalizeAlertDirection = (text = "") =>
  text.includes("下") || text.toLowerCase().includes("below") ? "below" : "above";

const alertDirectionLabel = (direction) => (direction === "below" ? "以下" : "以上");

const formatBriefMoney = (value) => Number(value).toFixed(0);
const formatBriefPercent = (value) => Number(value).toFixed(2);
const briefSign = (value) => (value > 0 ? "+" : "");

const getTaipeiNow = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return {
    dateKey: `${pick("year")}-${pick("month")}-${pick("day")}`,
    timeKey: `${pick("hour")}:${pick("minute")}`,
    weekday: pick("weekday")
  };
};

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

const getPortfolioOwnerKeys = async () => {
  if (!hasPortfolioDb) {
    return [...portfolios.keys()];
  }

  const response = await axios.get(portfolioApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      select: "owner_key",
      limit: 1000
    }
  });

  return [...new Set((response.data || []).map((row) => row.owner_key).filter(Boolean))];
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
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
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

const getAllTrades = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolioTrades.get(ownerKey) || [];
  }

  const response = await axios.get(tradeApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "id,code,trade_type,shares,price,fee,tax,realized_profit,traded_at",
      order: "traded_at.desc",
      limit: 1000
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

const roundPrice = (value) => Math.round(Number(value) * 100) / 100;

const calculateCostBandRows = async (ownerKey, percent = 30) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  const ratio = Number(percent) / 100;
  return entries
    .map(([code, position]) => {
      const averageCost = Number(position.averageCost);
      if (!Number.isFinite(averageCost) || averageCost <= 0) {
        return null;
      }
      return {
        code,
        averageCost,
        upperPrice: roundPrice(averageCost * (1 + ratio)),
        lowerPrice: roundPrice(averageCost * (1 - ratio))
      };
    })
    .filter(Boolean);
};

const setupCostBandAlerts = async (ownerKey, percent) => {
  const rows = await calculateCostBandRows(ownerKey, percent);
  for (const row of rows) {
    await savePriceAlert(ownerKey, {
      code: row.code,
      direction: "above",
      targetPrice: row.upperPrice
    });
    await savePriceAlert(ownerKey, {
      code: row.code,
      direction: "below",
      targetPrice: row.lowerPrice
    });
  }

  return rows;
};

const getCostBandAlertRows = async (ownerKey, percent = 30) => {
  const expectedRows = await calculateCostBandRows(ownerKey, percent);
  const alerts = await getPriceAlerts(ownerKey);
  const isSamePrice = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
  return expectedRows.map((row) => ({
    ...row,
    upperActive: alerts.some(
      (alert) =>
        alert.code === row.code &&
        alert.direction === "above" &&
        isSamePrice(alert.targetPrice, row.upperPrice)
    ),
    lowerActive: alerts.some(
      (alert) =>
        alert.code === row.code &&
        alert.direction === "below" &&
        isSamePrice(alert.targetPrice, row.lowerPrice)
    )
  }));
};

const dailyReportStockNames = {
  "00929": "復華台灣科技優息",
  "1513": "中興電",
  "1802": "台玻",
  "2330": "台積電",
  "2344": "華邦電",
  "2353": "宏碁",
  "2368": "金像電",
  "2409": "友達",
  "2449": "京元電子",
  "2454": "聯發科",
  "2812": "台中銀",
  "2834": "臺企銀",
  "3037": "欣興",
  "3455": "由田",
  "3481": "群創",
  "3552": "同致",
  "3680": "家登",
  "4132": "國鼎",
  "6125": "廣運",
  "6531": "愛普*",
  "7769": "鴻勁",
  "8046": "南電"
};

const dailyName = (code, fallback) =>
  dailyReportStockNames[code] || fallback || code;

const stockLabel = (code, fallback) => `${dailyName(code, fallback)}（${code}）`;

const ANALYSIS_EXCLUDED_SYMBOLS = new Set(
  String(process.env.ANALYSIS_EXCLUDED_SYMBOLS || "3552")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
);
const isAnalysisExcludedSymbol = (code) =>
  ANALYSIS_EXCLUDED_SYMBOLS.has(String(code || "").trim());
const analysisEntries = (entries) =>
  entries.filter(([code]) => !isAnalysisExcludedSymbol(code));
const analysisItems = (items) =>
  items.filter((item) => !isAnalysisExcludedSymbol(item?.code));

const dailyMoney = (value) => Number(value || 0).toFixed(0);
const dailyPercent = (value) => Number(value || 0).toFixed(2);
const dailySign = (value) => (Number(value) > 0 ? "+" : "");

const getDailyPortfolioSnapshots = async (entries) =>
  Promise.all(
    entries.map(async ([code, position]) => {
      try {
        const quote = await fetchAlertYahooQuote(code, 2500);
        const price = Number(quote.regularMarketPrice);
        if (!Number.isFinite(price)) {
          throw new Error("price not available");
        }

        const shares = Number(position.shares || 0);
        const averageCost = Number(position.averageCost || 0);
        const costValue = shares * averageCost;
        const marketValue = shares * price;
        const profit = marketValue - costValue;
        const profitPercent = costValue > 0 ? (profit / costValue) * 100 : 0;

        return {
          code,
          name: dailyName(code),
          shares,
          averageCost,
          price,
          costValue,
          marketValue,
          profit,
          profitPercent
        };
      } catch {
        return {
          code,
          name: dailyName(code),
          shares: Number(position.shares || 0),
          averageCost: Number(position.averageCost || 0),
          error: true
        };
      }
    })
  );

const dailyTotals = (snapshots) => {
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

const dailyRankRows = (items, valueFormatter, limit = 3) =>
  items
    .slice(0, limit)
    .map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)}：${valueFormatter(item)}`)
    .join("\n") || "暫無資料";

const dailyCompactRankRows = (items, valueFormatter, limit = 3) =>
  items
    .slice(0, limit)
    .map(
      (item, index) =>
        `${index + 1}. ${dailyName(item.code, item.name)} (${item.code}): ${valueFormatter(item)}`
    )
    .join("\n") || "暫無資料";

const defaultDailyReportSetting = () => ({
  enabled: DAILY_REPORT_ENABLED,
  times: DAILY_REPORT_TIMES,
  mode: DAILY_REPORT_MODE === "full" ? "full" : "compact"
});

const parseDailyReportTimes = (text) => {
  const times = String(text || "")
    .replace(/，/g, ",")
    .split(/[,\s]+/)
    .map((time) => time.trim())
    .filter(Boolean);

  if (times.length === 0) {
    return null;
  }

  const normalized = [];
  for (const time of times) {
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    normalized.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }

  return [...new Set(normalized)];
};

const normalizeDailyReportMode = (text) => {
  const value = String(text || "").trim().toLowerCase();
  if (["完整", "full", "f"].includes(value)) {
    return "full";
  }
  if (["精簡", "简洁", "compact", "c"].includes(value)) {
    return "compact";
  }
  return null;
};

const getDailyReportSetting = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return dailyReportSettings.get(ownerKey) || defaultDailyReportSetting();
  }

  try {
    const response = await axios.get(dailyReportSettingApiUrl(), {
      headers: supabaseHeaders(),
      params: {
        owner_key: `eq.${ownerKey}`,
        select: "enabled,times,mode",
        limit: 1
      }
    });
    const row = (response.data || [])[0];
    if (!row) {
      return defaultDailyReportSetting();
    }

    return {
      enabled: row.enabled !== false,
      times: parseDailyReportTimes(row.times) || DAILY_REPORT_TIMES,
      mode: normalizeDailyReportMode(row.mode) || defaultDailyReportSetting().mode
    };
  } catch (error) {
    if (error.response?.status === 404) {
      return defaultDailyReportSetting();
    }
    throw error;
  }
};

const saveDailyReportSetting = async (ownerKey, setting) => {
  const current = await getDailyReportSetting(ownerKey);
  const next = {
    enabled:
      typeof setting.enabled === "boolean" ? setting.enabled : current.enabled,
    times: setting.times || current.times,
    mode: setting.mode || current.mode
  };

  if (!hasPortfolioDb) {
    dailyReportSettings.set(ownerKey, next);
    return next;
  }

  try {
    await axios.post(
      `${dailyReportSettingApiUrl()}?on_conflict=owner_key`,
      {
        owner_key: ownerKey,
        enabled: next.enabled,
        times: next.times.join(","),
        mode: next.mode
      },
      {
        headers: {
          ...supabaseHeaders(),
          Prefer: "resolution=merge-duplicates,return=minimal"
        }
      }
    );
  } catch (error) {
    if (error.response?.status === 404) {
      dailyReportSettings.set(ownerKey, next);
      return next;
    }
    throw error;
  }

  return next;
};

const buildDailyAutoPortfolioReport = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return "📅 每日自動報告\n\n目前沒有持股資料。";
  }

  const snapshots = await getDailyPortfolioSnapshots(entries);
  const totals = dailyTotals(snapshots);
  const realizedProfit = await getRealizedProfit(ownerKey);
  const dividendTotal = await getDividendTotal(ownerKey);
  const alerts = await getPriceAlerts(ownerKey);
  const totalReturn = totals.totalProfit + realizedProfit + dividendTotal;
  const now = getTaipeiNow();

  if (totals.successful.length === 0) {
    return `📅 每日自動報告
${now.dateKey} ${now.timeKey}

目前即時報價查詢失敗，請稍後再試。`;
  }

  const rankedHoldings = analysisItems(totals.successful);
  const strongest = [...rankedHoldings].sort(
    (a, b) => b.profitPercent - a.profitPercent
  );
  const weakest = [...rankedHoldings].sort(
    (a, b) => a.profitPercent - b.profitPercent
  );
  const topWeights = [...rankedHoldings].sort(
    (a, b) => b.marketValue - a.marketValue
  );

  return `📅 每日自動報告
${now.dateKey} ${now.timeKey}

📌 資產概況
持股檔數：${entries.length} 檔
總成本：${dailyMoney(totals.totalCost)} 元
總市值：${dailyMoney(totals.totalMarket)} 元
未實現損益：${dailySign(totals.totalProfit)}${dailyMoney(totals.totalProfit)} 元
未實現報酬率：${dailySign(totals.totalPercent)}${dailyPercent(totals.totalPercent)}%
已實現損益：${dailySign(realizedProfit)}${dailyMoney(realizedProfit)} 元
股息/股利：${dailyMoney(dividendTotal)} 元
含股息總收益：${dailySign(totalReturn)}${dailyMoney(totalReturn)} 元

📈 表現較強
${dailyRankRows(strongest, (item) => `${dailySign(item.profitPercent)}${dailyPercent(item.profitPercent)}%，${dailySign(item.profit)}${dailyMoney(item.profit)} 元`)}

📉 表現較弱
${dailyRankRows(weakest, (item) => `${dailySign(item.profitPercent)}${dailyPercent(item.profitPercent)}%，${dailySign(item.profit)}${dailyMoney(item.profit)} 元`)}

🏦 市值前三
${dailyRankRows(topWeights, (item) => `${dailyMoney(item.marketValue)} 元`)}

🔔 提醒
價格提醒：${alerts.length} 筆
報價失敗：${totals.failedCount} 檔
可輸入「異常摘要」查看成本異常提醒。`;
};

const buildDailyCompactPortfolioReport = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return "📅 每日精簡報告\n\n目前沒有持股資料。";
  }

  const snapshots = await getDailyPortfolioSnapshots(entries);
  const totals = dailyTotals(snapshots);
  const dividendTotal = await getDividendTotal(ownerKey);
  const alerts = await getPriceAlerts(ownerKey);
  const now = getTaipeiNow();

  if (totals.successful.length === 0) {
    return `📅 每日精簡報告
${now.dateKey} ${now.timeKey}

目前即時報價查詢失敗，請稍後再試。`;
  }

  const rankedHoldings = analysisItems(totals.successful);
  const strongest = [...rankedHoldings]
    .sort((a, b) => b.profitPercent - a.profitPercent)
    .slice(0, 3);
  const weakest = [...rankedHoldings]
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 3);
  const totalReturn = totals.totalProfit + dividendTotal;
  const strongRows = dailyCompactRankRows(
    strongest,
    (item) =>
      `${dailySign(item.profitPercent)}${dailyPercent(item.profitPercent)}%，${dailySign(item.profit)}${dailyMoney(item.profit)} 元`
  );
  const weakRows = dailyCompactRankRows(
    weakest,
    (item) =>
      `${dailySign(item.profitPercent)}${dailyPercent(item.profitPercent)}%，${dailySign(item.profit)}${dailyMoney(item.profit)} 元`
  );

  return `📅 每日精簡報告
${now.dateKey} ${now.timeKey}

總市值：${dailyMoney(totals.totalMarket)} 元
未實現損益：${dailySign(totals.totalProfit)}${dailyMoney(totals.totalProfit)} 元
未實現報酬率：${dailySign(totals.totalPercent)}${dailyPercent(totals.totalPercent)}%
股息/股利：${dailyMoney(dividendTotal)} 元
含股息收益：${dailySign(totalReturn)}${dailyMoney(totalReturn)} 元

表現較強：
${strongRows}

表現較弱：
${weakRows}

提醒：價格提醒 ${alerts.length} 筆，報價失敗 ${totals.failedCount} 檔。
完整內容可輸入「每日報告完整」。`;
};

const checkAndPushDailyReports = async (force = false, onlyOwnerKey = null) => {
  if (!hasPortfolioDb) {
    return [];
  }

  const now = getTaipeiNow();
  if (!force && (now.weekday === "Sat" || now.weekday === "Sun")) {
    return [];
  }
  const ownerKeys = onlyOwnerKey ? [onlyOwnerKey] : await getPortfolioOwnerKeys();
  const results = [];
  for (const ownerKey of ownerKeys) {
    const setting = await getDailyReportSetting(ownerKey);
    if (!force && (!setting.enabled || setting.times.length === 0)) {
      continue;
    }
    if (!force && !setting.times.includes(now.timeKey)) {
      continue;
    }

    const pushKey = `${now.dateKey}|${now.timeKey}|daily-report|${ownerKey}`;
    if (!force && dailyReportPushLog.has(pushKey)) {
      continue;
    }
    if (shouldSkipLinePush(ownerKey, "scheduled", LINE_SCHEDULED_PUSH_MIN_GAP_MS, force)) {
      results.push({ ownerKey, pushed: false, skipped: "cooldown" });
      continue;
    }

    const text =
      setting.mode === "full"
        ? await buildDailyAutoPortfolioReport(ownerKey)
        : await buildDailyCompactPortfolioReport(ownerKey);
    await client.pushMessage(ownerKey, {
      type: "text",
      text
    });
    markLinePush(ownerKey, "scheduled");
    dailyReportPushLog.add(pushKey);
    results.push({ ownerKey, pushed: true });
  }

  return results;
};

const deleteCostBandAlerts = async (ownerKey, percent = 30) => {
  const rows = await calculateCostBandRows(ownerKey, percent);
  let deleted = 0;
  for (const row of rows) {
    if (!hasPortfolioDb) {
      const alerts = priceAlerts.get(ownerKey) || [];
      const before = alerts.length;
      priceAlerts.set(
        ownerKey,
        alerts.filter(
          (alert) =>
            !(
              alert.code === row.code &&
              ((alert.direction === "above" &&
                Math.abs(Number(alert.targetPrice) - row.upperPrice) < 0.01) ||
                (alert.direction === "below" &&
                  Math.abs(Number(alert.targetPrice) - row.lowerPrice) < 0.01))
            )
        )
      );
      deleted += before - (priceAlerts.get(ownerKey) || []).length;
      continue;
    }

    for (const [direction, targetPrice] of [
      ["above", row.upperPrice],
      ["below", row.lowerPrice]
    ]) {
      await axios.delete(alertApiUrl(), {
        headers: supabaseHeaders(),
        params: {
          owner_key: `eq.${ownerKey}`,
          code: `eq.${row.code}`,
          direction: `eq.${direction}`
        }
      });
      deleted += 1;
    }
  }
  return { rows, deleted };
};

const costTierLabel = (percent) => {
  const value = Number(percent);
  if (value >= 50) return "重大";
  if (value >= 30) return "警戒";
  if (value >= 15) return "注意";
  return "觀察";
};

const parseCostTierPercents = (text, fallback = [15, 30, 50]) => {
  const numbers = String(text || "")
    .split(/[,\s，、]+/)
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 100);
  const source = numbers.length > 0 ? numbers : fallback;
  return [...new Set(source.map((value) => roundPrice(value)))].sort((a, b) => a - b);
};

const tieredCostAlertKey = (alert) =>
  `${alert.code}:${alert.percent}:${alert.direction}`;

const saveTieredCostAlert = async (ownerKey, alert) => {
  if (!hasPortfolioDb) {
    const alerts = tieredCostAlerts.get(ownerKey) || [];
    const nextAlerts = alerts.filter((item) => tieredCostAlertKey(item) !== tieredCostAlertKey(alert));
    nextAlerts.push({ ...alert, active: true, createdAt: new Date().toISOString() });
    tieredCostAlerts.set(ownerKey, nextAlerts);
    return;
  }

  await axios.post(
    `${tieredCostAlertApiUrl()}?on_conflict=owner_key,code,percent,direction`,
    {
      owner_key: ownerKey,
      code: alert.code,
      percent: alert.percent,
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

const getTieredCostAlerts = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return (tieredCostAlerts.get(ownerKey) || []).filter((alert) => alert.active !== false);
  }

  const response = await axios.get(tieredCostAlertApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      active: "eq.true",
      select: "code,percent,direction,target_price,created_at",
      order: "percent.asc"
    }
  });

  return (response.data || []).map((row) => ({
    code: row.code,
    percent: Number(row.percent),
    direction: row.direction,
    targetPrice: Number(row.target_price),
    createdAt: row.created_at
  }));
};

const getAllActiveTieredCostAlerts = async () => {
  if (!hasPortfolioDb) {
    return [...tieredCostAlerts.entries()].flatMap(([ownerKey, alerts]) =>
      alerts
        .filter((alert) => alert.active !== false)
        .map((alert) => ({ ...alert, ownerKey }))
    );
  }

  const response = await axios.get(tieredCostAlertApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      active: "eq.true",
      select: "owner_key,code,percent,direction,target_price,created_at",
      order: "percent.asc"
    }
  });

  return (response.data || []).map((row) => ({
    ownerKey: row.owner_key,
    code: row.code,
    percent: Number(row.percent),
    direction: row.direction,
    targetPrice: Number(row.target_price),
    createdAt: row.created_at
  }));
};

const deactivateTieredCostAlert = async (ownerKey, alert) => {
  if (!hasPortfolioDb) {
    const alerts = tieredCostAlerts.get(ownerKey) || [];
    tieredCostAlerts.set(
      ownerKey,
      alerts.map((item) =>
        tieredCostAlertKey(item) === tieredCostAlertKey(alert)
          ? { ...item, active: false, lastTriggeredAt: new Date().toISOString() }
          : item
      )
    );
    return;
  }

  await axios.patch(
    tieredCostAlertApiUrl(),
    {
      active: false,
      last_triggered_at: new Date().toISOString()
    },
    {
      headers: supabaseHeaders(),
      params: {
        owner_key: `eq.${ownerKey}`,
        code: `eq.${alert.code}`,
        percent: `eq.${alert.percent}`,
        direction: `eq.${alert.direction}`
      }
    }
  );
};

const setupTieredCostAlerts = async (ownerKey, percents) => {
  const rows = [];
  for (const percent of percents) {
    const costRows = await calculateCostBandRows(ownerKey, percent);
    for (const row of costRows) {
      const upperAlert = {
        code: row.code,
        percent,
        direction: "above",
        targetPrice: row.upperPrice
      };
      const lowerAlert = {
        code: row.code,
        percent,
        direction: "below",
        targetPrice: row.lowerPrice
      };
      await saveTieredCostAlert(ownerKey, upperAlert);
      await saveTieredCostAlert(ownerKey, lowerAlert);
      rows.push({ ...row, percent });
    }
  }
  return rows;
};

const deleteTieredCostAlerts = async (ownerKey, percents = []) => {
  const alerts = await getTieredCostAlerts(ownerKey);
  const targets =
    percents.length > 0
      ? alerts.filter((alert) => percents.includes(Number(alert.percent)))
      : alerts;
  let deleted = 0;

  if (!hasPortfolioDb) {
    const deleteKeys = new Set(targets.map(tieredCostAlertKey));
    const before = (tieredCostAlerts.get(ownerKey) || []).length;
    tieredCostAlerts.set(
      ownerKey,
      (tieredCostAlerts.get(ownerKey) || []).filter((alert) => !deleteKeys.has(tieredCostAlertKey(alert)))
    );
    return { deleted: before - (tieredCostAlerts.get(ownerKey) || []).length };
  }

  for (const alert of targets) {
    await axios.delete(tieredCostAlertApiUrl(), {
      headers: supabaseHeaders(),
      params: {
        owner_key: `eq.${ownerKey}`,
        code: `eq.${alert.code}`,
        percent: `eq.${alert.percent}`,
        direction: `eq.${alert.direction}`
      }
    });
    deleted += 1;
  }
  return { deleted };
};

const buildTieredCostAlertStatus = async (ownerKey) => {
  const alerts = await getTieredCostAlerts(ownerKey);
  if (alerts.length === 0) {
    return "目前沒有成本異常分級提醒。\n可輸入：成本異常分級 15 30 50";
  }

  const grouped = new Map();
  for (const alert of alerts) {
    const key = `${alert.code}:${alert.percent}`;
    const group = grouped.get(key) || {
      code: alert.code,
      percent: alert.percent,
      upper: null,
      lower: null
    };
    if (alert.direction === "above") group.upper = alert.targetPrice;
    if (alert.direction === "below") group.lower = alert.targetPrice;
    grouped.set(key, group);
  }

  const rows = [...grouped.values()]
    .sort((a, b) => a.code.localeCompare(b.code) || a.percent - b.percent)
    .slice(0, 18)
    .map(
      (row, index) =>
        `${index + 1}. ${stockLabel(row.code, stockNames[row.code])} ${formatMoney(
          row.percent
        )}% ${costTierLabel(row.percent)}\n上線：${row.upper ?? "-"} 元｜下線：${
          row.lower ?? "-"
        } 元`
    )
    .join("\n\n");

  const hidden = grouped.size > 18 ? `\n\n...還有 ${grouped.size - 18} 組` : "";
  return `📋 成本異常分級狀態

啟用提醒：${alerts.length} 筆
分級組數：${grouped.size} 組

${rows}${hidden}`;
};

const buildTieredCostAlertSummary = async (ownerKey) => {
  const fmt = (value) => Number(value || 0).toFixed(0);
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]).filter(([, position]) => {
    const shares = Number(position.shares || 0);
    const averageCost = Number(position.averageCost || 0);
    return shares > 0 && averageCost > 0;
  });

  if (entries.length === 0) {
    return "\uD83C\uDFAF \u6210\u672C\u7570\u5E38\u6458\u8981\n\n\u76EE\u524D\u6C92\u6709\u53EF\u5957\u7528\u7684\u6301\u80A1\u6210\u672C\u8CC7\u6599\u3002\n\u53EF\u5148\u8F38\u5165\uFF1A\u6211\u7684\u6301\u80A1";
  }

  const percents = [15, 30, 50];
  const totalAlerts = entries.length * percents.length * 2;
  const rows = entries.map(([code, position]) => ({
    code,
    shares: Number(position.shares || 0),
    averageCost: Number(position.averageCost || 0),
    costValue: Number(position.shares || 0) * Number(position.averageCost || 0)
  }));
  const totalCost = rows.reduce((sum, row) => sum + row.costValue, 0);

  const largest = [...rows]
    .sort((a, b) => b.costValue - a.costValue)
    .slice(0, 5)
    .map((item, index) =>
      (index + 1) + ". " + item.code + "\uFF1A\u6210\u672C " + fmt(item.averageCost) + " \u5143\uFF0C\u90E8\u4F4D " + fmt(item.costValue) + " \u5143"
    )
    .join("\n");

  const tierRows = percents
    .map((percent) => {
      const count = entries.length;
      return fmt(percent) + "%\uFF1A" + (count * 2) + " \u7B46\uFF08\u4E0A\u7DDA " + count + " / \u4E0B\u7DDA " + count + "\uFF09";
    })
    .join("\n");

  return "\uD83C\uDFAF \u6210\u672C\u7570\u5E38\u6458\u8981\n\n" +
    "\u8CC7\u6599\u4F86\u6E90\uFF1A\u76EE\u524D\u6301\u80A1\u5E73\u5747\u6210\u672C\n" +
    "\u5957\u7528\u6301\u80A1\uFF1A" + entries.length + " \u6A94\n" +
    "\u4F30\u7B97\u63D0\u9192\uFF1A" + totalAlerts + " \u7B46\n" +
    "\u6301\u80A1\u7E3D\u6210\u672C\uFF1A" + fmt(totalCost) + " \u5143\n\n" +
    "\u5206\u7D1A\u4F30\u7B97\uFF1A\n" +
    tierRows + "\n\n" +
    "\u6210\u672C\u90E8\u4F4D\u524D 5\uFF1A\n" +
    largest + "\n\n" +
    "\u63D0\u793A\uFF1A\u9019\u662F\u7A69\u5B9A\u7248\u6458\u8981\uFF0C\u53EA\u8B80\u6301\u80A1\u8868\uFF0C\u4E0D\u67E5\u63D0\u9192\u8868\u3002\n" +
    "\u5B8C\u6574\u63D0\u9192\u6E05\u55AE\uFF1A\u6210\u672C\u7570\u5E38\u5206\u7D1A\u67E5\u770B";
};

const checkAndPushTieredCostAlerts = async () => {
  if (!hasPortfolioDb) {
    return;
  }

  let alerts = [];
  try {
    alerts = await getAllActiveTieredCostAlerts();
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      console.log("Tiered cost alerts skipped: cost_band_alerts table is not ready");
      return;
    }
    throw error;
  }

  if (alerts.length === 0) {
    return;
  }

  console.log(`Checking ${alerts.length} tiered cost alerts`);

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
      if (shouldSkipLinePush(alert.ownerKey, "price-alerts", LINE_ALERT_PUSH_MIN_GAP_MS)) {
        continue;
      }

      await client.pushMessage(alert.ownerKey, {
        type: "text",
        text: `🚨 成本異常分級到價

股票：${stockLabel(alert.code, stockNames[alert.code])}
等級：${formatMoney(alert.percent)}% ${costTierLabel(alert.percent)}
方向：${alert.direction === "above" ? "高於平均成本" : "低於平均成本"}
現價：${price} 元
門檻：${alert.targetPrice} 元

此分級提醒已自動關閉；需要再提醒請重新設定。`
      });
      markLinePush(alert.ownerKey, "price-alerts");

      await deactivateTieredCostAlert(alert.ownerKey, alert);
    } catch (error) {
      console.error("Tiered cost alert check failed:", {
        ownerKey: alert.ownerKey,
        code: alert.code,
        percent: alert.percent,
        direction: alert.direction,
        error: error.message
      });
    }
  }
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
      if (shouldSkipLinePush(alert.ownerKey, "price-alerts", LINE_ALERT_PUSH_MIN_GAP_MS)) {
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
      markLinePush(alert.ownerKey, "price-alerts");

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

const buildIntradayPortfolioBrief = async (ownerKey, stockNameLookup = {}) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return null;
  }

  const snapshots = await Promise.all(
    entries.map(async ([code, position]) => {
      try {
        const quote = await fetchAlertYahooQuote(code, 2500);
        const price = Number(quote.regularMarketPrice);
        if (!Number.isFinite(price)) {
          throw new Error("查無報價");
        }
        const costValue = Number(position.averageCost) * Number(position.shares);
        const marketValue = price * Number(position.shares);
        const profit = marketValue - costValue;
        const profitPercent = costValue > 0 ? (profit / costValue) * 100 : 0;
        return {
          code,
          name: stockNameLookup[code] || code,
          shares: Number(position.shares),
          price,
          marketValue,
          costValue,
          profit,
          profitPercent,
          error: false
        };
      } catch {
        return {
          code,
          name: stockNameLookup[code] || code,
          shares: Number(position.shares),
          error: true
        };
      }
    })
  );

  const successful = snapshots.filter((item) => !item.error);
  if (successful.length === 0) {
    return `📡 盤中持股快訊

目前持股檔數：${entries.length} 檔
即時報價暫時查詢失敗，稍後可再輸入「盤中快訊」。`;
  }

  const totalCost = successful.reduce((sum, item) => sum + item.costValue, 0);
  const totalMarket = successful.reduce((sum, item) => sum + item.marketValue, 0);
  const totalProfit = totalMarket - totalCost;
  const totalPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  const rankedHoldings = analysisItems(successful);
  const topGainers = [...rankedHoldings]
    .sort((a, b) => b.profitPercent - a.profitPercent)
    .slice(0, 3);
  const topLosers = [...rankedHoldings]
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 3);
  const topWeights = [...rankedHoldings]
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, 3);
  const now = getTaipeiNow();
  const row = (item, index, withProfit = true) =>
        `${index + 1}. ${stockLabel(item.code, item.name)}：${
      withProfit
        ? `${briefSign(item.profitPercent)}${formatBriefPercent(
            item.profitPercent
          )}%，${briefSign(item.profit)}${formatBriefMoney(item.profit)} 元`
        : `${formatBriefMoney(item.marketValue)} 元`
    }`;

  return `📡 盤中持股快訊
${now.dateKey} ${now.timeKey}

持股檔數：${entries.length} 檔
總市值：${formatBriefMoney(totalMarket)} 元
總成本：${formatBriefMoney(totalCost)} 元
未實現損益：${briefSign(totalProfit)}${formatBriefMoney(totalProfit)} 元
未實現報酬率：${briefSign(totalPercent)}${formatBriefPercent(totalPercent)}%

表現較強：
${topGainers.map((item, index) => row(item, index)).join("\n")}

表現較弱：
${topLosers.map((item, index) => row(item, index)).join("\n")}

市值前三：
${topWeights.map((item, index) => row(item, index, false)).join("\n")}${
    snapshots.length - successful.length > 0
      ? `\n\n提醒：${snapshots.length - successful.length} 檔報價失敗，未列入統計。`
      : ""
  }

提醒：這是盤中即時估算，不含尚未入帳的成交與稅費差異。`;
};

const checkAndPushIntradayBriefs = async (force = false) => {
  if (!hasPortfolioDb || !INTRADAY_PUSH_ENABLED || INTRADAY_PUSH_TIMES.length === 0) {
    return;
  }

  const now = getTaipeiNow();
  if (!force && (now.weekday === "Sat" || now.weekday === "Sun")) {
    return;
  }
  if (!force && !INTRADAY_PUSH_TIMES.includes(now.timeKey)) {
    return;
  }

  const ownerKeys = await getPortfolioOwnerKeys();
  for (const ownerKey of ownerKeys) {
    const pushKey = `${now.dateKey}|${now.timeKey}|${ownerKey}`;
    if (intradayBriefPushLog.has(pushKey)) {
      continue;
    }

    const text = await buildIntradayPortfolioBrief(ownerKey);
    if (!text) {
      continue;
    }

    await client.pushMessage(ownerKey, {
      type: "text",
      text
    });
    intradayBriefPushLog.add(pushKey);
  }
};

const intradayAnalysisStartDate = (days = 14) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

const signedLots = (value) =>
  `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(0)} 張`;
const signedMoney = (value) =>
  `${Number(value) > 0 ? "+" : ""}${formatBriefMoney(value)} 元`;
const signedPercent = (value) =>
  `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const toLineSafeText = (text, limit = 4800) => {
  const value = String(text || "");
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n（內容較長，已先截斷。可再輸入「盤中分析」重新查詢。）`;
};

const lineAgentText = {
  help: `AI 個人管家

你可以直接在 LINE 輸入：
1. 今日報告
2. 持股健檢
3. 風險排行
4. 分析 2330
5. 助理狀態
6. 助理記憶
7. 助理建議
8. 找資料 AI Agent
9. 鬧鐘 07:30 起床
10. 提醒 30分鐘 喝水
11. 起床 07:10
12. 睡覺 23:50
13. 作息紀錄
14. 鬧鐘列表

安全規則：
- 我只做分析與建議，不會自動買賣股票。
- 我不會刪除資料。
- 資料不足時會明講，不硬猜。
- 買進、續抱、減碼、賣出都只會用「建議」形式呈現。
- 鬧鐘、作息、查資料與最近查詢會保存到管家記憶。

建議用法：
早上記「起床」，盤中問「分析 股票代號」，晚上記「睡覺」，需要查東西就輸入「找資料 關鍵字」。`,
  noPortfolio: "目前沒有持股資料，請先同步網頁資產表或輸入「匯入持股」。",
  stockNotFound: "找不到這支股票，請輸入股票代號，例如：分析 2330。",
  safeNotice: "提醒：這是 AI 風險分析與決策輔助，不是自動交易指令；買賣前請自行確認資金、風險與最新資訊。"
};

const lineAgentProfile = {
  owner: "個人使用",
  market: "台股",
  primaryInterface: "LINE 手機",
  style: "個人管家、穩健投資、重視配息、作息紀錄與 AI 輔助決策",
  forbiddenActions: ["刪除資料", "自動買賣股票", "操作券商帳戶"],
  dataSources: ["LINE 持股資料", "交易紀錄", "股利紀錄", "Yahoo 報價", "AI dashboard", "FinMind 籌碼資料", "Google News RSS"]
};

const normalizeLineAgentCommand = (text) =>
  String(text || "")
    .trim()
    .replace(/\s+/g, " ");

const parseLineAgentIntent = (text) => {
  const input = normalizeLineAgentCommand(text);
  const geminiStockReviewMatch = input.match(/^(?:Gemini交叉檢查|gemini交叉檢查|GEMINI交叉檢查|交叉檢查)\s+(.+)$/i);
  if (geminiStockReviewMatch) {
    return { type: "geminiStockReview", input: geminiStockReviewMatch[1] };
  }
  const geminiMatch = input.match(/^(?:Gemini|gemini|GEMINI)(?:整理|分析|摘要|檢查|回答|幫我)?\s+(.+)$/i);
  if (geminiMatch) {
    return { type: "geminiButler", input: geminiMatch[1] };
  }
  if (/^(AI助理|全面AI助理|股票助理|助理|功能|指令)$/i.test(input)) {
    return { type: "help" };
  }
  if (/^(今日報告|今日總結|持股日報|每日報告|日報)$/i.test(input)) {
    return { type: "dailyReport" };
  }
  if (/^(持股健檢|AI持股健檢|健檢持股|看持股|我的持股健檢)$/i.test(input)) {
    return { type: "portfolioHealth" };
  }
  if (/^(風險排行|風險控管|持股風險|高風險持股)$/i.test(input)) {
    return { type: "riskRanking" };
  }
  if (/^(助理狀態|AI狀態|助理健檢|AI健檢)$/i.test(input)) {
    return { type: "assistantStatus" };
  }
  if (/^(助理記憶|AI記憶|最近查詢|查詢記憶)$/i.test(input)) {
    return { type: "assistantMemory" };
  }
  if (/^(助理建議|下一步|下一步建議|AI建議)$/i.test(input)) {
    return { type: "assistantSuggestions" };
  }
  if (/^(管家|個人管家|管家功能|生活管家)$/i.test(input)) {
    return { type: "butlerHelp" };
  }
  if (/^(作息紀錄|睡眠紀錄|生活紀錄|起床睡覺紀錄)$/i.test(input)) {
    return { type: "lifeLog" };
  }
  if (/^(鬧鐘列表|提醒列表|我的鬧鐘|我的提醒)$/i.test(input)) {
    return { type: "reminderList" };
  }

  const wakeMatch = input.match(/^(?:起床|記起床|我起床了)(?:\s+(.+))?$/i);
  if (wakeMatch) {
    return { type: "wakeLog", input: wakeMatch[1] || "" };
  }
  const sleepMatch = input.match(/^(?:睡覺|記睡覺|我睡了|我要睡了)(?:\s+(.+))?$/i);
  if (sleepMatch) {
    return { type: "sleepLog", input: sleepMatch[1] || "" };
  }
  const reminderMatch = input.match(/^(?:鬧鐘|提醒|提醒我)\s+(.+)$/i);
  if (reminderMatch) {
    return { type: "setReminder", input: reminderMatch[1] };
  }
  const searchMatch = input.match(/^(?:找資料|查資料|搜尋|幫我查)\s+(.+)$/i);
  if (searchMatch) {
    return { type: "searchInfo", input: searchMatch[1] };
  }

  const analysisMatch = input.match(/^(?:分析|AI分析|助理分析)\s*([0-9A-Za-z]{4,6}|\S+)$/i);
  if (analysisMatch) {
    return { type: "stockAnalysis", input: analysisMatch[1] };
  }

  return null;
};

const parseLineAgentIntents = (text) => {
  const input = String(text || "").trim();
  const parts = input
    .split(/[\n。；;]+|(?<=\S)\.(?=\S)/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const intents = parts.map(parseLineAgentIntent).filter(Boolean);
    return intents.length === parts.length ? intents : [];
  }

  const direct = parseLineAgentIntent(input);
  return direct ? [direct] : [];
};

const formatLineAgentNumber = (value, decimals = 0) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(decimals) : "資料不足";

const formatLineAgentRawPercent = (value) => formatLineAgentNumber(value, 2);

const formatLineAgentMoney = (value) =>
  Number.isFinite(Number(value)) ? `${formatLineAgentNumber(value, 0)} 元` : "資料不足";

const formatLineAgentPercent = (value) =>
  Number.isFinite(Number(value))
    ? `${Number(value) > 0 ? "+" : ""}${formatLineAgentRawPercent(value)}%`
    : "資料不足";

const formatLineAgentPrice = (value) =>
  Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} 元` : "資料不足";

const getButlerMemory = (ownerKey) => {
  const saved =
    lineButlerLifeMemory.get(ownerKey) || {
      wakeLogs: [],
      sleepLogs: [],
      searches: []
    };
  lineButlerLifeMemory.set(ownerKey, saved);
  return saved;
};

const normalizeButlerLifeMemory = (value = {}) => ({
  wakeLogs: Array.isArray(value.wakeLogs) ? value.wakeLogs.slice(0, 30) : [],
  sleepLogs: Array.isArray(value.sleepLogs) ? value.sleepLogs.slice(0, 30) : [],
  searches: Array.isArray(value.searches) ? value.searches.slice(0, 20) : []
});

const normalizeButlerAgentMemory = (value = {}) => ({
  updatedAt: value.updatedAt || null,
  counts: value.counts && typeof value.counts === "object" ? value.counts : {},
  recent: Array.isArray(value.recent) ? value.recent.slice(0, 8) : [],
  symbols: value.symbols && typeof value.symbols === "object" ? value.symbols : {}
});

const normalizeButlerReminders = (value = []) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => item && item.id && item.dueAt)
    .slice(-50);

const lineAgentStockNames = {
  "1301": "台塑",
  "1303": "南亞",
  "2002": "中鋼",
  "2303": "聯電",
  "2308": "台達電",
  "2317": "鴻海",
  "2330": "台積電",
  "2382": "廣達",
  "2412": "中華電",
  "2454": "聯發科",
  "2603": "長榮",
  "2618": "長榮航",
  "2881": "富邦金",
  "2882": "國泰金",
  "2891": "中信金",
  "3008": "大立光",
  "3552": "同致"
};

const lineAgentReverseStockNames = Object.fromEntries(
  Object.entries(lineAgentStockNames).map(([code, name]) => [name, code])
);

const resolveLineAgentStockCode = (input) => {
  const normalized = String(input || "").trim();
  return lineAgentReverseStockNames[normalized] || normalized;
};

const getLineAgentPortfolioSnapshots = async (entries, options = {}) => {
  const timeoutMs = options.timeoutMs || 2500;
  const raceMs = options.raceMs || 3500;

  return Promise.all(
    entries.map(async ([code, position]) =>
      Promise.race([
        (async () => {
          try {
            const quote = await fetchAlertYahooQuote(code, timeoutMs);
            const price = Number(quote.regularMarketPrice);
            const shares = Number(position.shares);
            const averageCost = Number(position.averageCost);
            if (!Number.isFinite(price) || !Number.isFinite(shares) || !Number.isFinite(averageCost)) {
              throw new Error("invalid portfolio snapshot");
            }

            const costValue = averageCost * shares;
            const marketValue = price * shares;
            const profit = marketValue - costValue;
            const profitPercent = costValue > 0 ? (profit / costValue) * 100 : 0;

            return {
              code,
              name: lineAgentStockNames[code] || code,
              shares,
              averageCost,
              price,
              costValue,
              marketValue,
              profit,
              profitPercent,
              error: false
            };
          } catch {
            return {
              code,
              name: lineAgentStockNames[code] || code,
              shares: Number(position.shares),
              averageCost: Number(position.averageCost),
              error: true
            };
          }
        })(),
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                code,
                name: lineAgentStockNames[code] || code,
                shares: Number(position.shares),
                averageCost: Number(position.averageCost),
                error: true
              }),
            raceMs
          )
        )
      ])
    )
  );
};

const getLineAgentPortfolioTotals = (snapshots = []) => {
  const successful = snapshots.filter((item) => !item.error);
  const totalCost = successful.reduce((sum, item) => sum + Number(item.costValue || 0), 0);
  const totalMarket = successful.reduce((sum, item) => sum + Number(item.marketValue || 0), 0);
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

const hydrateButlerCloudState = async (ownerKey) => {
  if (!ownerKey || lineButlerCloudLoaded.has(ownerKey)) return;
  lineButlerCloudLoaded.add(ownerKey);
  try {
    const state = await getSupabaseWebCloudState(ownerKey).catch(() => null);
    const butler = state?.__butler || {};
    if (butler.life) {
      lineButlerLifeMemory.set(ownerKey, normalizeButlerLifeMemory(butler.life));
    }
    if (butler.agentMemory) {
      lineAgentInteractionMemory.set(ownerKey, normalizeButlerAgentMemory(butler.agentMemory));
    }
    if (butler.reminders) {
      lineButlerReminders.set(ownerKey, normalizeButlerReminders(butler.reminders));
    }
  } catch (error) {
    console.warn(`Butler cloud memory load failed: ${serviceErrorMessage(error)}`);
  }
};

const saveButlerCloudState = async (ownerKey) => {
  if (!ownerKey || !hasPortfolioDb) return false;
  try {
    const existingState = (await getSupabaseWebCloudState(ownerKey).catch(() => null)) || {};
    const nextState = {
      ...existingState,
      __butler: {
        ...(existingState.__butler || {}),
        life: normalizeButlerLifeMemory(getButlerMemory(ownerKey)),
        agentMemory: normalizeButlerAgentMemory(lineAgentInteractionMemory.get(ownerKey) || {}),
        reminders: normalizeButlerReminders(lineButlerReminders.get(ownerKey) || []),
        updatedAt: new Date().toISOString()
      },
      _updatedAt: Date.now()
    };
    await saveSupabaseWebCloudState(ownerKey, nextState);
    return true;
  } catch (error) {
    console.warn(`Butler cloud memory save failed: ${serviceErrorMessage(error)}`);
    return false;
  }
};

const taipeiDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    dateKey: `${pick("year")}-${pick("month")}-${pick("day")}`,
    timeKey: `${pick("hour")}:${pick("minute")}`
  };
};

const parseButlerClock = (text) => {
  const value = String(text || "").trim();
  if (!value || /^(現在|now)$/i.test(value)) {
    return new Date();
  }
  const clock = value.match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!clock) return null;

  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const now = new Date();
  const parts = taipeiDateParts(now);
  const utc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 8, minute, 0);
  return new Date(utc);
};

const parseButlerReminder = (input) => {
  const text = String(input || "").trim();
  const relative = text.match(/^(\d+)\s*(分鐘|分|小時|時|天)\s*(.*)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const title = relative[3].trim() || "提醒";
    const multiplier =
      unit === "分鐘" || unit === "分"
        ? 60 * 1000
        : unit === "小時" || unit === "時"
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    return {
      dueAt: new Date(Date.now() + amount * multiplier),
      title
    };
  }

  const absolute = text.match(/^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+)?(\d{1,2})[:：](\d{1,2})(?:\s+(.+))?$/);
  if (absolute) {
    const now = new Date();
    const parts = taipeiDateParts(now);
    const year = Number(absolute[1] || parts.year);
    const month = Number(absolute[2] || parts.month);
    const day = Number(absolute[3] || parts.day);
    const hour = Number(absolute[4]);
    const minute = Number(absolute[5]);
    const title = (absolute[6] || "提醒").trim();
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    let dueAt = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
    if (!absolute[1] && dueAt.getTime() <= Date.now()) {
      dueAt = new Date(dueAt.getTime() + 24 * 60 * 60 * 1000);
    }
    return { dueAt, title };
  }

  return null;
};

const butlerTimeText = (date) =>
  new Date(date).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

const recordButlerLifeEvent = (ownerKey, type, input) => {
  const memory = getButlerMemory(ownerKey);
  const time = parseButlerClock(input);
  if (!time) {
    return `時間格式看不懂。請用：${type === "wake" ? "起床 07:10" : "睡覺 23:50"}，或直接輸入「${type === "wake" ? "起床" : "睡覺"}」記錄現在。`;
  }
  const row = {
    at: time.toISOString(),
    dateKey: taipeiDateParts(time).dateKey
  };
  const target = type === "wake" ? memory.wakeLogs : memory.sleepLogs;
  target.unshift(row);
  target.splice(30);

  const label = type === "wake" ? "起床" : "睡覺";
  const opposite =
    type === "wake"
      ? memory.sleepLogs.find((item) => item.dateKey === row.dateKey)
      : memory.wakeLogs.find((item) => item.dateKey === row.dateKey);
  const sleepHint =
    opposite && type === "wake"
      ? `\n昨晚/今日睡眠參考：睡覺 ${butlerTimeText(opposite.at)}，起床 ${butlerTimeText(row.at)}`
      : opposite
      ? `\n今日作息參考：起床 ${butlerTimeText(opposite.at)}，睡覺 ${butlerTimeText(row.at)}`
      : "";

  return `已記錄${label}時間：${butlerTimeText(row.at)}${sleepHint}\n\n輸入「作息紀錄」可查看最近紀錄。`;
};

const buildButlerLifeLog = (ownerKey) => {
  const memory = getButlerMemory(ownerKey);
  const wakeRows = memory.wakeLogs
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${butlerTimeText(item.at)}`);
  const sleepRows = memory.sleepLogs
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${butlerTimeText(item.at)}`);

  return `作息紀錄

最近起床
${wakeRows.length ? wakeRows.join("\n") : "尚未記錄"}

最近睡覺
${sleepRows.length ? sleepRows.join("\n") : "尚未記錄"}

可用指令：
起床 07:10
睡覺 23:50
起床
睡覺

提醒：作息與鬧鐘會保存到管家記憶。`;
};

const addButlerReminder = (ownerKey, input) => {
  const parsed = parseButlerReminder(input);
  if (!parsed || !parsed.dueAt || parsed.dueAt.getTime() <= Date.now()) {
    return "鬧鐘格式看不懂。請用：鬧鐘 07:30 起床，或：提醒 30分鐘 喝水。";
  }
  const rows = lineButlerReminders.get(ownerKey) || [];
  const reminder = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: parsed.title,
    dueAt: parsed.dueAt.toISOString(),
    createdAt: new Date().toISOString(),
    sent: false
  };
  rows.push(reminder);
  rows.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  lineButlerReminders.set(ownerKey, rows.slice(-50));

  return `已設定提醒
時間：${butlerTimeText(reminder.dueAt)}
內容：${reminder.title}

輸入「鬧鐘列表」可查看。`;
};

const buildButlerReminderList = (ownerKey) => {
  const rows = (lineButlerReminders.get(ownerKey) || [])
    .filter((item) => !item.sent && new Date(item.dueAt).getTime() > Date.now())
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .slice(0, 10);
  if (rows.length === 0) {
    return "目前沒有待提醒的鬧鐘。\n\n可輸入：鬧鐘 07:30 起床\n或：提醒 30分鐘 喝水";
  }
  return `鬧鐘列表

${rows.map((item, index) => `${index + 1}. ${butlerTimeText(item.dueAt)}｜${item.title}`).join("\n")}`;
};

const buildButlerSearchReport = async (ownerKey, query) => {
  const keyword = String(query || "").trim();
  if (!keyword) return "請輸入要找的資料，例如：找資料 AI Agent 架構。";

  const memory = getButlerMemory(ownerKey);
  memory.searches.unshift({ query: keyword, at: new Date().toISOString() });
  memory.searches.splice(20);

  const response = await axios.get("https://news.google.com/rss/search", {
    params: {
      q: keyword,
      hl: "zh-TW",
      gl: "TW",
      ceid: "TW:zh-Hant"
    },
    timeout: 10000
  });
  const $ = cheerio.load(response.data, { xmlMode: true });
  const items = $("item")
    .slice(0, 5)
    .map((_, item) => ({
      title: $(item).find("title").text().trim(),
      source: $(item).find("source").text().trim(),
      link: $(item).find("link").text().trim()
    }))
    .get();

  if (items.length === 0) {
    return `找不到「${keyword}」的近期資料。你可以換更精準的關鍵字。`;
  }

  return toLineSafeText(`我幫你找到這些資料：${keyword}

${items
  .map(
    (item, index) => `${index + 1}. ${item.title}
來源：${item.source || "Google News"}
${item.link}`
  )
  .join("\n\n")}

你可以接著問：「整理 ${keyword}」或「找資料 更精準的關鍵字」。`);
};

const normalizeGeminiModelName = (model) => String(model || GEMINI_MODEL).replace(/^models\//, "");

const extractGeminiText = (data) =>
  (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();

const geminiErrorMessage = (error) => {
  const detail = error?.response?.data;
  const apiError = detail?.error;
  if (apiError?.message) return `Gemini API ${apiError.code || ""}: ${apiError.message}`.trim();
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (error?.response?.status) return `Gemini API HTTP ${error.response.status}`;
  return error?.message || "Gemini API request failed";
};

const callGeminiText = async (prompt, options = {}) => {
  if (!GEMINI_API_KEY) {
    return `Gemini 尚未啟用。

請在 Railway Variables 新增：
GEMINI_API_KEY=你的 Google AI Studio API Key

可選：
GEMINI_MODEL=${GEMINI_MODEL}

設定後重新部署，管家就能用 Gemini 做長文整理、交叉檢查與第二意見。`;
  }

  const model = normalizeGeminiModelName(options.model);
  let response;
  try {
    response = await axios.post(
      `${GEMINI_API_BASE_URL}/v1beta/models/${model}:generateContent`,
      {
        systemInstruction: {
          parts: [
            {
              text:
                options.system ||
                "你是使用者的繁體中文個人 AI 管家。回答要精準、可執行、保守，不可刪資料，不可代替使用者買賣股票。"
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: String(prompt || "").slice(0, 24000) }]
          }
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.35,
          maxOutputTokens: options.maxOutputTokens ?? 1600
        }
      },
      {
        headers: { "x-goog-api-key": GEMINI_API_KEY },
        timeout: options.timeoutMs || 30000
      }
    );
  } catch (error) {
    throw new Error(geminiErrorMessage(error));
  }

  const text = extractGeminiText(response.data);
  return text || "Gemini 沒有回傳可讀文字，請稍後再試。";
};

const buildButlerContextForGemini = async (ownerKey) => {
  const state = await getButlerStateSnapshot(ownerKey).catch(() => null);
  if (!state) return "管家狀態：暫時無法讀取。";
  const latestWake = state.life?.wakeLogs?.[0]?.at ? butlerTimeText(state.life.wakeLogs[0].at) : "尚未記錄";
  const latestSleep = state.life?.sleepLogs?.[0]?.at ? butlerTimeText(state.life.sleepLogs[0].at) : "尚未記錄";
  const reminders = (state.pendingReminders || [])
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${butlerTimeText(item.dueAt)} ${item.title}`)
    .join("\n");
  return `管家狀態
版本：${BOT_BUILD_VERSION}
最近起床：${latestWake}
最近睡覺：${latestSleep}
待提醒：
${reminders || "目前沒有待提醒"}

安全規則：
- 不可刪資料。
- 不可替使用者買賣股票。
- 可以提供股票風險分析與買賣建議，但必須提醒使用者自行確認。`;
};

const buildGeminiButlerReply = async (ownerKey, input) => {
  const task = String(input || "").trim();
  if (!task) return "請輸入 Gemini 要處理的內容，例如：Gemini整理 這篇文章網址，或：Gemini 幫我規劃明天。";
  const memory = getButlerMemory(ownerKey);
  memory.searches.unshift({ query: `Gemini: ${task.slice(0, 80)}`, at: new Date().toISOString() });
  memory.searches.splice(20);
  const context = await buildButlerContextForGemini(ownerKey);
  const answer = await callGeminiText(`${context}

使用者任務：
${task}

請用繁體中文回答。若是整理文章或資料，請輸出重點、可行動建議、風險或限制。`, {
    maxOutputTokens: 1800
  });
  return toLineSafeText(`Gemini 管家回覆

${answer}`);
};

const buildGeminiStockReview = async (ownerKey, stockInput) => {
  const code = resolveLineAgentStockCode(stockInput);
  if (!/^\d{4,6}$/.test(code)) return "請輸入股票代號或已知股票名稱，例如：交叉檢查 2330。";
  const baseReport = await buildLineAgentStockAnalysis(ownerKey, code);
  const context = await buildButlerContextForGemini(ownerKey);
  const answer = await callGeminiText(`${context}

以下是現有股票助理報告，請你用第二意見角度交叉檢查：

${baseReport}

請輸出：
1. 原報告最可靠的 3 點
2. 可能忽略的風險
3. 買進、續抱、減碼、停利或停損的條件式建議
4. 明確提醒：不可視為自動交易指令`, {
    temperature: 0.25,
    maxOutputTokens: 1800
  });
  return toLineSafeText(`Gemini 股票交叉檢查：${stockLabel(code, lineAgentStockNames[code])}

${answer}`);
};

const rememberLineAgentInteraction = (ownerKey, intent) => {
  if (!ownerKey || !intent) return;
  const saved =
    lineAgentInteractionMemory.get(ownerKey) || {
      updatedAt: null,
      counts: {},
      recent: [],
      symbols: {}
    };
  saved.updatedAt = new Date().toISOString();
  saved.counts[intent.type] = (saved.counts[intent.type] || 0) + 1;
  if (intent.input) {
    const code = resolveLineAgentStockCode(intent.input);
    if (/^\d{4,6}$/.test(code)) {
      saved.symbols[code] = (saved.symbols[code] || 0) + 1;
    }
  }
  saved.recent.unshift({
    type: intent.type,
    input: intent.input || "",
    at: saved.updatedAt
  });
  saved.recent = saved.recent.slice(0, 8);
  lineAgentInteractionMemory.set(ownerKey, saved);
};

const lineAgentIntentLabel = (type) =>
  ({
    help: "功能查詢",
    dailyReport: "今日報告",
    portfolioHealth: "持股健檢",
    riskRanking: "風險排行",
    stockAnalysis: "個股分析",
    assistantStatus: "助理狀態",
    assistantMemory: "助理記憶",
    assistantSuggestions: "助理建議",
    geminiButler: "Gemini 管家",
    geminiStockReview: "Gemini 股票交叉檢查"
  }[type] || type);

const buildLineAgentMemoryReport = async (ownerKey) => {
  const saved = lineAgentInteractionMemory.get(ownerKey);
  const life = getButlerMemory(ownerKey);
  const reminders = (lineButlerReminders.get(ownerKey) || []).filter((item) => !item.sent);
  if (!saved || saved.recent.length === 0) {
    return `AI 助理記憶

目前這次服務啟動後還沒有可整理的 AI 助理查詢紀錄。

我會開始記錄：
1. 最近使用的 AI 指令
2. 常查股票代號
3. 你偏好看今日報告、持股健檢或風險排行
4. 起床與睡覺時間
5. 待提醒鬧鐘

注意：目前是輕量記憶，服務重啟後會重新累積；不會記錄 LINE token 或任何密鑰。`;
  }

  const symbolRows = Object.entries(saved.symbols)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count], index) => `${index + 1}. ${stockLabel(code, lineAgentStockNames[code])}：${count} 次`);
  const recentRows = saved.recent
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${lineAgentIntentLabel(item.type)}${item.input ? ` ${item.input}` : ""}`);
  const countRows = Object.entries(saved.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${lineAgentIntentLabel(type)}：${count} 次`);

  return toLineSafeText(`AI 助理記憶

最近更新：${new Date(saved.updatedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}

最近查詢
${recentRows.join("\n")}

常查股票
${symbolRows.length ? symbolRows.join("\n") : "尚未累積個股查詢"}

使用偏好
${countRows.join("\n")}

生活管家
最近起床：${life.wakeLogs[0] ? butlerTimeText(life.wakeLogs[0].at) : "尚未記錄"}
最近睡覺：${life.sleepLogs[0] ? butlerTimeText(life.sleepLogs[0].at) : "尚未記錄"}
待提醒：${reminders.length} 筆
最近查資料：${life.searches[0]?.query || "尚未查詢"}

我會用這些輕量記憶，優先幫你看常問股票、持股風險與報告節奏。
${lineAgentText.safeNotice}`);
};

const buildLineAgentStatus = async (ownerKey) => {
  const diagnostics = await buildSystemDiagnostics();
  const portfolio = await getPortfolio(ownerKey);
  const memory = lineAgentInteractionMemory.get(ownerKey);
  const life = getButlerMemory(ownerKey);
  const reminders = (lineButlerReminders.get(ownerKey) || []).filter((item) => !item.sent);
  const warnings = diagnostics.warnings?.length ? diagnostics.warnings.join("；") : "無";

  return toLineSafeText(`AI 助理狀態

版本：${BOT_BUILD_VERSION}
定位：${lineAgentProfile.owner}｜${lineAgentProfile.market}｜${lineAgentProfile.primaryInterface}
投資風格：${lineAgentProfile.style}

資料健康
系統：${diagnostics.ok ? "正常" : "需要檢查"}
持股：${portfolio.size} 檔
LINE 資料：持股 ${diagnostics.lineData?.holdings ?? 0}｜交易 ${diagnostics.lineData?.trades ?? 0}｜股利 ${diagnostics.lineData?.dividends ?? 0}
雲端資料：交易 ${diagnostics.cloudData?.trades ?? 0}｜股利 ${diagnostics.cloudData?.dividends ?? 0}｜快照 ${diagnostics.cloudData?.snapshots ?? 0}
報價：${diagnostics.checks?.quote?.ok ? `正常，2330 ${diagnostics.checks.quote.price}` : "異常"}
AI dashboard：已接入 /api/ai-dashboard-summary/:symbol

能力
1. 今日報告
2. 持股健檢
3. 風險排行
4. 個股 AI 分析
5. 最近查詢記憶
6. 助理下一步建議
7. 查資料
8. 鬧鐘/提醒
9. 起床與睡眠時間紀錄

安全邊界
${lineAgentProfile.forbiddenActions.map((item, index) => `${index + 1}. 不${item}`).join("\n")}

記憶狀態：${memory?.recent?.length ? `已累積 ${memory.recent.length} 筆最近查詢` : "尚未累積"}
作息狀態：起床 ${life.wakeLogs.length} 筆｜睡覺 ${life.sleepLogs.length} 筆
提醒狀態：待提醒 ${reminders.length} 筆
提醒：${warnings}`);
};

const buildLineAgentSuggestions = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return lineAgentText.noPortfolio;
  }

  const snapshots = await getLineAgentPortfolioSnapshots(entries, { timeoutMs: 2500, raceMs: 3500 });
  const totals = getLineAgentPortfolioTotals(snapshots);
  const ranked = analysisItems(totals.successful).map((item) => ({
    ...item,
    weight: totals.totalMarket > 0 ? (item.marketValue / totals.totalMarket) * 100 : 0
  }));
  const heavy = [...ranked].sort((a, b) => b.weight - a.weight).slice(0, 3);
  const weak = [...ranked].sort((a, b) => a.profitPercent - b.profitPercent).slice(0, 3);
  const strong = [...ranked].sort((a, b) => b.profitPercent - a.profitPercent).slice(0, 3);

  const heavyRows = heavy.map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentRawPercent(item.weight)}%`);
  const weakRows = weak.map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentPercent(item.profitPercent)}`);
  const strongRows = strong.map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentPercent(item.profitPercent)}`);

  return toLineSafeText(`AI 助理下一步建議

今天建議你照這個順序處理：

1. 先看風險
輸入：風險排行
原因：先處理虧損與集中部位，避免單一持股拖累整體資產。

2. 再看重倉股
${heavyRows.join("\n") || "資料不足"}

3. 檢查弱勢股
${weakRows.join("\n") || "資料不足"}

4. 檢查強勢股是否需要停利計畫
${strongRows.join("\n") || "資料不足"}

5. 如果要深入個股，輸入：
分析 股票代號
例如：分析 ${heavy[0]?.code || "2330"}

我的判斷：
- 若重倉股同時虧損，優先做風險控管。
- 若強勢股已大幅獲利，先規劃分批停利，不急著全出。
- 若弱勢股沒有基本面或籌碼支持，不建議只因跌深就加碼。

${lineAgentText.safeNotice}`);
};

const fetchAiDashboardSummaryForAgent = async (symbol) => {
  const normalized = normalizeDashboardSymbol(symbol);
  if (!normalized) return null;

  try {
    const response = await axios.get(`${AI_DASHBOARD_BASE_URL}/api/dashboard`, {
      params: { symbol: normalized, timeframe: "D", refresh: "false" },
      timeout: 10000
    });
    return compactAiDashboardSummary(response.data, normalized);
  } catch (error) {
    console.warn(`AI dashboard summary unavailable for ${normalized}: ${serviceErrorMessage(error)}`);
    return null;
  }
};

const buildLineAgentPortfolioHealth = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return lineAgentText.noPortfolio;
  }

  const snapshots = await getLineAgentPortfolioSnapshots(entries, { timeoutMs: 2500, raceMs: 3500 });
  const totals = getLineAgentPortfolioTotals(snapshots);
  if (totals.successful.length === 0) {
    return "目前即時報價查詢失敗，暫時無法產生持股健檢。";
  }

  const ranked = analysisItems(totals.successful);
  const byProfit = [...ranked].sort((a, b) => b.profitPercent - a.profitPercent);
  const byLoss = [...ranked].sort((a, b) => a.profitPercent - b.profitPercent);
  const byWeight = [...ranked]
    .map((item) => ({
      ...item,
      weight: totals.totalMarket > 0 ? (item.marketValue / totals.totalMarket) * 100 : 0
    }))
    .sort((a, b) => b.weight - a.weight);

  const topRows = byProfit.slice(0, 3).map(
    (item, index) =>
      `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentPercent(item.profitPercent)}`
  );
  const watchRows = byLoss.slice(0, 3).map(
    (item, index) =>
      `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentPercent(item.profitPercent)}`
  );
  const weightRows = byWeight.slice(0, 3).map(
    (item, index) =>
      `${index + 1}. ${stockLabel(item.code, item.name)} ${formatLineAgentRawPercent(item.weight)}%`
  );

  const concentrationRisk = byWeight.some((item) => item.weight >= 20);
  const lossRisk = byLoss.some((item) => item.profitPercent <= -15);
  const riskLevel = concentrationRisk && lossRisk ? "偏高" : concentrationRisk || lossRisk ? "中等" : "穩定";

  return toLineSafeText(`AI 持股健檢

結論：目前風險等級 ${riskLevel}
持股檔數：${entries.length} 檔
總市值：${formatLineAgentMoney(totals.totalMarket)}
未實現損益：${formatLineAgentMoney(totals.totalProfit)}（${formatLineAgentPercent(totals.totalPercent)}）

表現較強
${topRows.join("\n") || "資料不足"}

優先留意
${watchRows.join("\n") || "資料不足"}

部位集中度
${weightRows.join("\n") || "資料不足"}

操作建議：
1. 單一持股超過 20% 時，先控管集中風險。
2. 虧損超過 15% 的持股，重新檢查買進理由與停損計畫。
3. 獲利持股可分批檢視停利，不要一次用情緒決策。

${lineAgentText.safeNotice}`);
};

const buildLineAgentRiskRanking = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return lineAgentText.noPortfolio;
  }

  const snapshots = await getLineAgentPortfolioSnapshots(entries, { timeoutMs: 2500, raceMs: 3500 });
  const totals = getLineAgentPortfolioTotals(snapshots);
  const ranked = analysisItems(totals.successful)
    .map((item) => {
      const weight = totals.totalMarket > 0 ? (item.marketValue / totals.totalMarket) * 100 : 0;
      const lossScore = item.profitPercent < 0 ? Math.min(45, Math.abs(item.profitPercent)) : 0;
      const weightScore = Math.min(35, weight * 1.2);
      const volatilityScore = Math.abs(item.profitPercent) >= 20 ? 10 : 0;
      return {
        ...item,
        weight,
        riskScore: Math.round(lossScore + weightScore + volatilityScore)
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  if (ranked.length === 0) {
    return "目前即時報價查詢失敗，暫時無法產生風險排行。";
  }

  const rows = ranked.map(
    (item, index) =>
      `${index + 1}. ${stockLabel(item.code, item.name)}
風險分：${item.riskScore}
損益：${formatLineAgentPercent(item.profitPercent)}
部位：${formatLineAgentRawPercent(item.weight)}%`
  );

  return toLineSafeText(`AI 風險排行

${rows.join("\n\n")}

判讀：
- 風險分越高，代表虧損幅度、部位集中度或波動風險越需要優先處理。
- 高風險不等於一定要賣出，但應該先檢查停損、資金占比與最新消息。

${lineAgentText.safeNotice}`);
};

const buildLineAgentStockAnalysis = async (ownerKey, stockInput) => {
  const code = resolveLineAgentStockCode(stockInput);
  if (!/^\d{4,6}$/.test(code)) {
    return lineAgentText.stockNotFound;
  }

  const quoteRequest =
    typeof fetchYahooQuote === "function" ? fetchYahooQuote(code, 3500).catch(() => null) : Promise.resolve(null);
  const [quote, dashboard, portfolio] = await Promise.all([
    quoteRequest,
    fetchAiDashboardSummaryForAgent(code),
    getPortfolio(ownerKey).catch(() => new Map())
  ]);
  if (!quote && !dashboard) {
    return `目前查不到 ${stockLabel(code, lineAgentStockNames[code])} 的行情或 AI 分析資料。`;
  }

  const position = portfolio.get(code);
  const price = Number(quote?.regularMarketPrice ?? dashboard?.price);
  const previousClose = Number(quote?.previousClose);
  const changePercent =
    Number.isFinite(price) && Number.isFinite(previousClose) && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : dashboard?.changeRate;
  const positionText = position
    ? `目前持有：${formatLineAgentNumber(position.shares, 0)} 股，平均成本 ${formatLineAgentPrice(position.averageCost)}`
    : "目前持股：未持有或尚未同步";
  const positionPnL =
    position && Number.isFinite(price)
      ? `持股損益：約 ${formatLineAgentMoney((price - Number(position.averageCost)) * Number(position.shares))}（${formatLineAgentPercent(((price - Number(position.averageCost)) / Number(position.averageCost)) * 100)}）`
      : "持股損益：資料不足";

  const dashboardLines = dashboard
    ? [
        `AI 訊號：${dashboard.signal || "資料不足"}`,
        `AI 標題：${dashboard.headline || "資料不足"}`,
        `信心 / 風險：${dashboard.confidence ?? "?"} / ${dashboard.risk ?? "?"}`,
        `策略：${dashboard.strategy || "資料不足"}`,
        `目標 / 停損：${formatLineAgentPrice(dashboard.target)} / ${formatLineAgentPrice(dashboard.stop)}`,
        `籌碼：${dashboard.chipRank || "資料不足"}`,
        `健康度：${dashboard.health || "資料不足"}`
      ]
    : ["AI dashboard：暫時無法取得，先用即時行情與持股資料判斷。"];

  const action =
    dashboard?.signal ||
    (Number.isFinite(changePercent) && changePercent <= -3
      ? "觀察風險"
      : Number.isFinite(changePercent) && changePercent >= 3
      ? "留意追高"
      : "觀望");

  return toLineSafeText(`AI 個股分析：${stockLabel(code, lineAgentStockNames[code])}

結論：${action}
現價：${formatLineAgentPrice(price)}
今日漲跌：${formatLineAgentPercent(changePercent)}
${positionText}
${positionPnL}

AI 分析
${dashboardLines.join("\n")}

我的建議：
1. 已持有：先看停損價、部位比重與 AI 風險分，不要只看單日漲跌。
2. 未持有：等回檔或訊號轉強再評估，不建議因單一訊號追價。
3. 若 AI 風險分偏高，先降低部位或設定明確停損，而不是加碼攤平。

${lineAgentText.safeNotice}`);
};

const buildLineAgentReply = async (intent, ownerKey) => {
  if (!intent) return null;
  await hydrateButlerCloudState(ownerKey);
  let reply = null;
  if (intent.type === "help") reply = lineAgentText.help;
  else if (intent.type === "dailyReport") reply = await buildDailyAutoPortfolioReport(ownerKey);
  else if (intent.type === "portfolioHealth") reply = await buildLineAgentPortfolioHealth(ownerKey);
  else if (intent.type === "riskRanking") reply = await buildLineAgentRiskRanking(ownerKey);
  else if (intent.type === "assistantStatus") reply = await buildLineAgentStatus(ownerKey);
  else if (intent.type === "assistantMemory") reply = await buildLineAgentMemoryReport(ownerKey);
  else if (intent.type === "assistantSuggestions") reply = await buildLineAgentSuggestions(ownerKey);
  else if (intent.type === "butlerHelp") reply = lineAgentText.help;
  else if (intent.type === "wakeLog") reply = recordButlerLifeEvent(ownerKey, "wake", intent.input);
  else if (intent.type === "sleepLog") reply = recordButlerLifeEvent(ownerKey, "sleep", intent.input);
  else if (intent.type === "lifeLog") reply = buildButlerLifeLog(ownerKey);
  else if (intent.type === "setReminder") reply = addButlerReminder(ownerKey, intent.input);
  else if (intent.type === "reminderList") reply = buildButlerReminderList(ownerKey);
  else if (intent.type === "searchInfo") reply = await buildButlerSearchReport(ownerKey, intent.input);
  else if (intent.type === "stockAnalysis") reply = await buildLineAgentStockAnalysis(ownerKey, intent.input);
  else if (intent.type === "geminiButler") reply = await buildGeminiButlerReply(ownerKey, intent.input);
  else if (intent.type === "geminiStockReview") reply = await buildGeminiStockReview(ownerKey, intent.input);

  await saveButlerCloudState(ownerKey);
  return reply;
};

const buildLineAgentReplies = async (text, ownerKey) => {
  const intents = parseLineAgentIntents(text);
  if (intents.length === 0) {
    return {
      ok: false,
      replies: [],
      text: "管家目前看不懂這個指令。可輸入：管家、鬧鐘 06:05 起床、睡覺 23:00、找資料 AI Agent、分析 2330。"
    };
  }

  const replies = [];
  for (const intent of intents) {
    try {
      rememberLineAgentInteraction(ownerKey, intent);
      const reply = await buildLineAgentReply(intent, ownerKey);
      if (reply) replies.push(reply);
    } catch (error) {
      const message = serviceErrorMessage(error);
      console.error("LINE agent intent failed", {
        ownerKey,
        intentType: intent.type,
        input: intent.input,
        error: message
      });
      replies.push(`管家指令失敗：${intent.type}\n原因：${message || "未知錯誤"}\n\n請稍後重試，或先改用單一句指令。`);
    }
  }
  return {
    ok: true,
    replies,
    text: replies.join("\n\n---\n\n")
  };
};

const getButlerStateSnapshot = async (ownerKey) => {
  await hydrateButlerCloudState(ownerKey);
  const life = normalizeButlerLifeMemory(getButlerMemory(ownerKey));
  const agentMemory = normalizeButlerAgentMemory(lineAgentInteractionMemory.get(ownerKey) || {});
  const reminders = normalizeButlerReminders(lineButlerReminders.get(ownerKey) || []);
  return {
    ok: true,
    version: BOT_BUILD_VERSION,
    life,
    agentMemory,
    reminders,
    pendingReminders: reminders.filter((item) => !item.sent && new Date(item.dueAt).getTime() > Date.now()),
    updatedAt: new Date().toISOString()
  };
};

const TDCC_SHAREHOLDING_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";
const TDCC_SHAREHOLDING_CACHE_MS = 6 * 60 * 60 * 1000;
const SHAREHOLDING_BIG_TIERS = new Set([12, 13, 14, 15]);
const SHAREHOLDING_RETAIL_TIERS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

const parseTdccNumber = (value) =>
  Number(String(value || "0").replace(/,/g, "").trim()) || 0;

const formatTdccDate = (value) => {
  const text = String(value || "").trim();
  if (text.length !== 8) return text || "未知日期";
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
};

const parseTdccShareholdingCsv = (csvText) => {
  const rowsByCode = new Map();
  const lines = String(csvText || "").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const [date, code, tier, holders, shares, percent] = line.split(",");
    const stockCode = String(code || "").trim();
    const level = Number(String(tier || "").trim());
    if (!stockCode || !Number.isFinite(level)) continue;
    if (!rowsByCode.has(stockCode)) rowsByCode.set(stockCode, []);
    rowsByCode.get(stockCode).push({
      date: String(date || "").trim(),
      code: stockCode,
      tier: level,
      holders: parseTdccNumber(holders),
      shares: parseTdccNumber(shares),
      percent: Number(String(percent || "0").trim()) || 0
    });
  }
  return rowsByCode;
};

const getTdccShareholdingRowsByCode = async () => {
  if (
    tdccShareholdingCache.rowsByCode.size > 0 &&
    Date.now() - tdccShareholdingCache.fetchedAt < TDCC_SHAREHOLDING_CACHE_MS
  ) {
    return tdccShareholdingCache;
  }

  const response = await axios.get(TDCC_SHAREHOLDING_URL, {
    responseType: "text",
    timeout: 15000,
    transformResponse: [(data) => data]
  });
  const rowsByCode = parseTdccShareholdingCsv(response.data);
  const firstRows = [...rowsByCode.values()][0] || [];
  tdccShareholdingCache = {
    fetchedAt: Date.now(),
    rowsByCode,
    sourceDate: firstRows[0]?.date || null
  };
  return tdccShareholdingCache;
};

const summarizeShareholdingRows = (rows) => {
  if (!rows || rows.length === 0) return null;
  const totalRow = rows.find((row) => row.tier === 17);
  const sumPercent = (tiers) =>
    rows
      .filter((row) => tiers.has(row.tier))
      .reduce((sum, row) => sum + Number(row.percent || 0), 0);
  const sumHolders = (tiers) =>
    rows
      .filter((row) => tiers.has(row.tier))
      .reduce((sum, row) => sum + Number(row.holders || 0), 0);
  const bigPercent = sumPercent(SHAREHOLDING_BIG_TIERS);
  const retailPercent = sumPercent(SHAREHOLDING_RETAIL_TIERS);
  const megaRow = rows.find((row) => row.tier === 15);
  const totalHolders = totalRow?.holders || rows.reduce((sum, row) => sum + row.holders, 0);
  let level = "中性";
  const reasons = [];
  if (bigPercent >= 70 && retailPercent <= 15) {
    level = "集中";
    reasons.push("大戶占比高、散戶占比低");
  } else if (bigPercent >= 55) {
    level = "偏集中";
    reasons.push("400 張以上持股占比較高");
  } else if (retailPercent >= 35 && bigPercent < 45) {
    level = "偏分散";
    reasons.push("50 張以下散戶占比偏高");
  } else {
    reasons.push("大戶與散戶占比未見極端");
  }
  if ((megaRow?.percent || 0) >= 45) reasons.push("千張以上占比高");
  return {
    date: rows[0]?.date || totalRow?.date,
    bigPercent,
    retailPercent,
    megaPercent: megaRow?.percent || 0,
    bigHolders: sumHolders(SHAREHOLDING_BIG_TIERS),
    retailHolders: sumHolders(SHAREHOLDING_RETAIL_TIERS),
    totalHolders,
    level,
    reasons
  };
};

const formatShareholdingPercent = (value) => `${Number(value || 0).toFixed(2)}%`;

const buildMajorHolderWeeklyReport = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return "大戶週報\n\n目前沒有持股資料。請先同步網頁資產表到 LINE。";
  }

  const tdcc = await getTdccShareholdingRowsByCode();
  const analyses = entries
    .map(([code]) => {
      const summary = summarizeShareholdingRows(tdcc.rowsByCode.get(code));
      return {
        code,
        name: dailyName(code),
        summary
      };
    })
    .filter((item) => item.summary);

  if (analyses.length === 0) {
    return `大戶週報

目前 ${entries.length} 檔持股都查不到集保級距資料。
資料來源：TDCC 集保戶股權分散表
更新頻率：每 7 日`;
  }

  const concentrated = [...analyses]
    .sort((a, b) => b.summary.bigPercent - a.summary.bigPercent)
    .slice(0, 5);
  const dispersed = [...analyses]
    .sort((a, b) => b.summary.retailPercent - a.summary.retailPercent)
    .slice(0, 5);
  const rows = [...analyses]
    .sort((a, b) => b.summary.bigPercent - a.summary.bigPercent)
    .slice(0, 10)
    .map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)}
等級：${item.summary.level}
大戶(400張+)：${formatShareholdingPercent(item.summary.bigPercent)}，千張以上：${formatShareholdingPercent(item.summary.megaPercent)}
散戶(50張以下)：${formatShareholdingPercent(item.summary.retailPercent)}，股東數：${formatBriefMoney(item.summary.totalHolders)} 人
判斷：${item.summary.reasons.join("、")}`)
    .join("\n\n");

  const simpleRank = (items, pick) =>
    items
      .map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${pick(item)}`)
      .join("\n");

  return toLineSafeText(`大戶週報
資料日期：${formatTdccDate(analyses[0].summary.date || tdcc.sourceDate)}
資料來源：TDCC 集保戶股權分散表，每 7 日更新

重點持股
${rows}

大戶集中前五
${simpleRank(concentrated, (item) => formatShareholdingPercent(item.summary.bigPercent))}

散戶占比前五
${simpleRank(dispersed, (item) => formatShareholdingPercent(item.summary.retailPercent))}

提醒：這是週資料，適合看籌碼結構，不是盤中即時買賣訊號。`);
};

const isEtfSymbol = (code) => /^00\d+/.test(String(code || ""));

const classifyDailyChipMovement = (code, chip, holder) => {
  let score = 0;
  const reasons = [];
  const isEtf = isEtfSymbol(code);

  if (chip?.available) {
    if (isEtf) {
      if (chip.total > 0) {
        score += 1;
        reasons.push("ETF 法人資金流入");
      } else if (chip.total < 0) {
        score -= 1;
        reasons.push("ETF 法人資金流出");
      }
      reasons.push("ETF 不用一般個股籌碼規則硬判買賣");
    } else if (chip.foreign > 0) {
      score += 2;
      reasons.push("外資買超");
    } else if (chip.foreign < 0) {
      score -= 2;
      reasons.push("外資賣超");
    }
    if (!isEtf && chip.trust > 0) {
      score += 1;
      reasons.push("投信買超");
    } else if (!isEtf && chip.trust < 0) {
      score -= 1;
      reasons.push("投信賣超");
    }
    if (!isEtf && chip.total > 0) {
      score += 1;
      reasons.push("三大法人合計買超");
    } else if (!isEtf && chip.total < 0) {
      score -= 1;
      reasons.push("三大法人合計賣超");
    }
  } else {
    reasons.push("法人日資料不足");
  }

  if (holder && isEtf) {
    reasons.push("ETF 集保級距只作持有人結構參考");
  } else if (holder) {
    if (holder.bigPercent >= 55) {
      score += 2;
      reasons.push("400 張以上大戶占比高");
    } else if (holder.bigPercent >= 45) {
      score += 1;
      reasons.push("大戶結構尚穩");
    }
    if (holder.retailPercent >= 35 && holder.bigPercent < 45) {
      score -= 2;
      reasons.push("散戶占比偏高");
    }
    if (holder.megaPercent >= 30) {
      score += 1;
      reasons.push("千張大戶占比偏高");
    }
  } else {
    reasons.push("TDCC 大戶週資料不足");
  }

  const level =
    score >= 4
      ? "偏多"
      : score >= 2
        ? "中性偏多"
        : score <= -3
          ? "偏空"
          : score <= -1
            ? "中性偏弱"
            : "觀察";

  return {
    score,
    level,
    reasons: reasons.length ? reasons : ["籌碼未見明顯方向"]
  };
};

const formatDailyChipPositionLine = (snapshot, totalMarket) => {
  if (!snapshot || snapshot.error) {
    return "部位：現價暫時查不到，先看籌碼方向";
  }
  const weight =
    totalMarket > 0 ? (Number(snapshot.marketValue || 0) / totalMarket) * 100 : 0;
  return `部位：占 ${formatBriefPercent(weight)}%，損益 ${signedMoney(
    snapshot.profit
  )}（${signedPercent(snapshot.profitPercent)}）`;
};

const buildDailyChipAction = (item) => {
  const profitPercent = Number(item.snapshot?.profitPercent || 0);
  const chipTotal = item.chip?.available ? Number(item.chip.total || 0) : 0;
  const foreign = item.chip?.available ? Number(item.chip.foreign || 0) : 0;
  const score = Number(item.movement.score || 0);
  const isEtf = isEtfSymbol(item.code);

  if (isEtf) {
    if (chipTotal < 0) {
      return "動作：配息部位續抱，但暫不追高加碼，先看資金流是否連續流出";
    }
    return "動作：配息部位續抱，除非收益率或配置比重失衡才調整";
  }
  if (profitPercent >= 25 && chipTotal < 0) {
    return "動作：獲利股可分批停利檢查，別讓法人轉賣把獲利吐回去";
  }
  if (score <= -3 && profitPercent < 0) {
    return "動作：列入減碼/停損檢查，等轉強再回補比硬撐好";
  }
  if (score <= -2) {
    return "動作：先不加碼，明天若外資續賣再降風險";
  }
  if (score >= 4 && profitPercent >= 0) {
    return "動作：續抱，若拉回但籌碼沒壞才考慮加碼";
  }
  if (score >= 3 && profitPercent < 0) {
    return "動作：先續抱觀察，籌碼撐住比單看帳面虧損重要";
  }
  if (foreign < 0 && chipTotal < 0) {
    return "動作：觀察，不急著買，等外資賣壓收斂";
  }
  return "動作：續抱觀察，沒有明確加碼或減碼訊號";
};

const buildDailyChipInsight = (item) => {
  const parts = [];
  const score = Number(item.movement.score || 0);
  const profitPercent = Number(item.snapshot?.profitPercent || 0);
  const chipTotal = item.chip?.available ? Number(item.chip.total || 0) : null;
  const foreign = item.chip?.available ? Number(item.chip.foreign || 0) : null;
  const holder = item.holder;

  if (score >= 4) parts.push("籌碼站在你這邊");
  if (score <= -3) parts.push("籌碼壓力偏重");
  if (profitPercent >= 20) parts.push("帳面獲利已高，重點是守獲利");
  if (profitPercent <= -8) parts.push("帳面虧損偏深，不能只靠期待攤平");
  if (foreign !== null && foreign > 0 && chipTotal > 0) parts.push("外資與三大法人同向買超");
  if (foreign !== null && foreign < 0 && chipTotal < 0) parts.push("外資與三大法人同向賣超");
  if (holder && !isEtfSymbol(item.code) && holder.bigPercent >= 55) {
    parts.push("大戶結構集中，籌碼比較不鬆");
  }
  if (holder && !isEtfSymbol(item.code) && holder.retailPercent >= 35) {
    parts.push("散戶占比偏高，上攻容易有賣壓");
  }
  if (isEtfSymbol(item.code)) {
    parts.push("ETF 主要看配息與配置，不用用個股主力邏輯判死刑");
  }

  return parts.slice(0, 3).join("；") || item.movement.reasons.slice(0, 3).join("、");
};

const buildDailyChipMovementReport = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return "每日持股籌碼動向\n\n目前沒有可分析的持股資料。請先同步網頁資產表到 LINE。";
  }

  const tdcc = await getTdccShareholdingRowsByCode().catch((error) => {
    console.error("TDCC shareholding fetch failed for daily chip movement:", error.message);
    return { rowsByCode: new Map(), sourceDate: null };
  });

  const snapshots = await getDailyPortfolioSnapshots(entries);
  const snapshotByCode = new Map(snapshots.map((item) => [item.code, item]));
  const totalMarket = snapshots
    .filter((item) => !item.error)
    .reduce((sum, item) => sum + Number(item.marketValue || 0), 0);

  const analyses = await Promise.all(
    entries.map(async ([code]) => {
      const chip = await fetchInstitutionalChipSummary(code);
      const holder = summarizeShareholdingRows(tdcc.rowsByCode.get(code));
      const movement = classifyDailyChipMovement(code, chip, holder);
      const snapshot = snapshotByCode.get(code);
      return {
        code,
        name: dailyName(code),
        chip,
        holder,
        movement,
        snapshot
      };
    })
  );

  const latestChipDate =
    analyses.find((item) => item.chip?.available)?.chip.latestDate || "查無法人日期";
  const latestHolderDate =
    analyses.find((item) => item.holder)?.holder.date || tdcc.sourceDate || "查無集保日期";

  const formatHolderLine = (holder) =>
    holder
      ? `大戶 ${formatShareholdingPercent(holder.bigPercent)}｜散戶 ${formatShareholdingPercent(holder.retailPercent)}`
      : "大戶/散戶：查無 TDCC 週資料";

  const formatChipLine = (chip) =>
    chip?.available
      ? `外資 ${signedLots(chip.foreign)}｜投信 ${signedLots(chip.trust)}｜自營 ${signedLots(chip.dealer)}｜合計 ${signedLots(chip.total)}`
      : chip?.text || "法人：查無資料";

  const formatRow = (item, index) => `${index + 1}. ${stockLabel(item.code, item.name)}：${item.movement.level}
${buildDailyChipAction(item)}
為什麼：${buildDailyChipInsight(item)}
${formatDailyChipPositionLine(item.snapshot, totalMarket)}
籌碼：${formatChipLine(item.chip)}
結構：${formatHolderLine(item.holder)}`;

  const weakRows = analyses
    .filter((item) => item.movement.score <= -1)
    .sort((a, b) => a.movement.score - b.movement.score)
    .slice(0, 5);
  const strongRows = analyses
    .filter((item) => item.movement.score >= 2)
    .sort((a, b) => b.movement.score - a.movement.score)
    .slice(0, 5);
  const watchRows = analyses
    .filter((item) => item.movement.score > -1 && item.movement.score < 2)
    .sort((a, b) => Math.abs(b.chip?.total || 0) - Math.abs(a.chip?.total || 0))
    .slice(0, 5);

  const renderSection = (title, rows, emptyText) => `${title}
${rows.length ? rows.map(formatRow).join("\n\n") : emptyText}`;

  const summaryRows = analyses
    .sort((a, b) => b.movement.score - a.movement.score)
    .map((item) => `${stockLabel(item.code, item.name)} ${item.movement.level}(${item.movement.score})`)
    .join("、");
  const urgentRows = [...weakRows, ...strongRows]
    .filter((item, index, rows) => rows.findIndex((row) => row.code === item.code) === index)
    .slice(0, 4)
    .map((item) => `${stockLabel(item.code, item.name)}：${item.movement.level}`)
    .join("、");
  const buySellBalance = analyses.reduce(
    (acc, item) => {
      if (!item.chip?.available) return acc;
      if (item.chip.total > 0) acc.positive += 1;
      if (item.chip.total < 0) acc.negative += 1;
      return acc;
    },
    { positive: 0, negative: 0 }
  );

  return toLineSafeText(`📊 每日持股行動雷達
法人資料日：${latestChipDate}
大戶資料日：${formatTdccDate(latestHolderDate)}

今日結論
三大法人買超持股 ${buySellBalance.positive} 檔、賣超 ${buySellBalance.negative} 檔。
今天先看：${urgentRows || "沒有特別需要優先處理的持股"}。

${renderSection("⚠️ 籌碼偏弱", weakRows, "目前沒有明顯偏弱持股。")}

${renderSection("✅ 籌碼偏強", strongRows, "目前沒有明顯偏強持股。")}

${renderSection("👀 觀察名單", watchRows, "目前沒有中性觀察名單。")}

全持股摘要
${summaryRows}

明天檢查
1. 偏弱股如果外資續賣，不加碼。
2. 偏強股若價格拉回但籌碼沒壞，才有加碼價值。
3. ETF 看配息與配置，不跟個股一起硬判多空。`);
};

const checkAndPushDailyChipMovementReports = async (force = false, onlyOwnerKey = null) => {
  if (!hasPortfolioDb || (!DAILY_CHIP_MOVEMENT_ENABLED && !force)) {
    return [];
  }

  const now = getTaipeiNow();
  if (!force && (now.weekday === "Sat" || now.weekday === "Sun")) {
    return [];
  }
  if (!force && !DAILY_CHIP_MOVEMENT_TIMES.includes(now.timeKey)) {
    return [];
  }

  const ownerKeys = onlyOwnerKey ? [onlyOwnerKey] : await getPortfolioOwnerKeys();
  const results = [];
  for (const ownerKey of ownerKeys) {
    const pushKey = `${now.dateKey}|${now.timeKey}|daily-chip-movement|${ownerKey}`;
    if (!force && dailyChipMovementPushLog.has(pushKey)) {
      continue;
    }
    if (shouldSkipLinePush(ownerKey, "daily-chip-movement", LINE_SCHEDULED_PUSH_MIN_GAP_MS, force)) {
      results.push({ ownerKey, pushed: false, skipped: "cooldown" });
      continue;
    }

    const text = await buildDailyChipMovementReport(ownerKey);
    await client.pushMessage(ownerKey, {
      type: "text",
      text
    });
    markLinePush(ownerKey, "daily-chip-movement");
    dailyChipMovementPushLog.add(pushKey);
    results.push({ ownerKey, pushed: true });
  }

  return results;
};

const fetchInstitutionalChipSummary = async (code) => {
  try {
    const response = await axios.get(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${code}&start_date=${intradayAnalysisStartDate(14)}`,
      { headers: { Authorization: `Bearer ${FINMIND_TOKEN}` }, timeout: 5000 }
    );
    const rows = response.data?.data || [];
    if (rows.length === 0) {
      return { available: false, text: "法人：查無資料" };
    }
    const latestDate = rows[rows.length - 1].date;
    const latestRows = rows.filter((item) => item.date === latestDate);
    const netLots = (...names) =>
      latestRows
        .filter((item) => names.includes(item.name))
        .reduce((sum, item) => sum + Number(item.buy || 0) - Number(item.sell || 0), 0) / 1000;
    const foreign = netLots("Foreign_Investor");
    const trust = netLots("Investment_Trust");
    const dealer = netLots("Dealer_self", "Dealer_Hedging");
    const total = foreign + trust + dealer;
    return {
      available: true,
      latestDate,
      foreign,
      trust,
      dealer,
      total,
      text: `法人(${latestDate})：外資 ${signedLots(foreign)}，投信 ${signedLots(trust)}，自營 ${signedLots(dealer)}，合計 ${signedLots(total)}`
    };
  } catch (error) {
    return { available: false, text: `法人：查詢失敗(${error.message})` };
  }
};

const fetchMarginChipSummary = async (code) => {
  try {
    const response = await axios.get(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${code}&start_date=${intradayAnalysisStartDate(14)}`,
      { headers: { Authorization: `Bearer ${FINMIND_TOKEN}` }, timeout: 5000 }
    );
    const rows = response.data?.data || [];
    if (rows.length === 0) {
      return { available: false, text: "融資融券：查無資料" };
    }
    const latest = rows[rows.length - 1];
    const marginChange =
      Number(latest.MarginPurchaseTodayBalance || 0) -
      Number(latest.MarginPurchaseYesterdayBalance || 0);
    const shortChange =
      Number(latest.ShortSaleTodayBalance || 0) -
      Number(latest.ShortSaleYesterdayBalance || 0);
    return {
      available: true,
      latestDate: latest.date,
      marginChange,
      shortChange,
      marginBalance: Number(latest.MarginPurchaseTodayBalance || 0),
      shortBalance: Number(latest.ShortSaleTodayBalance || 0),
      text: `融資融券(${latest.date})：融資 ${latest.MarginPurchaseTodayBalance} 張(${signedLots(marginChange)})，融券 ${latest.ShortSaleTodayBalance} 張(${signedLots(shortChange)})`
    };
  } catch (error) {
    return { available: false, text: `融資融券：查詢失敗(${error.message})` };
  }
};

const analysisLevelForHolding = (item, chip, margin, weightPercent) => {
  const reasons = [];
  let score = 0;
  if (item.profitPercent <= -10) {
    score += 4;
    reasons.push("跌破成本 10% 以上");
  } else if (item.profitPercent <= -5) {
    score += 2;
    reasons.push("跌破成本 5% 以上");
  }
  if (weightPercent >= 20) {
    score += 2;
    reasons.push("部位占比偏高");
  }
  if (chip?.available && chip.total < 0) {
    score += 1;
    reasons.push("三大法人賣超");
  }
  if (chip?.available && chip.foreign < 0) {
    score += 1;
    reasons.push("外資賣超");
  }
  if (margin?.available && margin.marginChange > 0 && item.profitPercent < 0) {
    score += 1;
    reasons.push("虧損中且融資增加");
  }
  if (item.profitPercent >= 20) {
    reasons.push("獲利已高，可檢視分批停利策略");
  }
  if (score >= 5) return { level: "高風險", reasons };
  if (score >= 3) return { level: "注意", reasons };
  if (item.profitPercent >= 20) return { level: "可檢視停利", reasons };
  return { level: "觀察", reasons: reasons.length ? reasons : ["未出現明顯籌碼或成本警訊"] };
};

const recommendIntradayAction = (item, chip, margin, level) => {
  const profitPercent = Number(item?.profitPercent || 0);
  const weightPercent = Number(item?.weightPercent || 0);
  const chipTotal = chip?.available ? Number(chip.total || 0) : null;
  const foreign = chip?.available ? Number(chip.foreign || 0) : null;
  const marginChange = margin?.available ? Number(margin.marginChange || 0) : null;
  const chipWeak = chipTotal !== null && chipTotal < 0;
  const foreignWeak = foreign !== null && foreign < 0;
  const marginRisk = marginChange !== null && marginChange > 0 && profitPercent < 0;
  const reasons = [];

  if (profitPercent <= -18 || (profitPercent <= -12 && (chipWeak || foreignWeak || marginRisk))) {
    if (profitPercent <= -18) reasons.push("虧損已深");
    if (chipWeak) reasons.push("法人賣超");
    if (foreignWeak) reasons.push("外資賣超");
    if (marginRisk) reasons.push("虧損中融資增加");
    return { action: "停損", reason: reasons.join("、") || "跌幅超過風控線" };
  }

  if (
    (profitPercent >= 25 && (chipWeak || weightPercent >= 15)) ||
    (weightPercent >= 20 && profitPercent >= 8) ||
    (level?.level === "高風險" && profitPercent > -18)
  ) {
    if (profitPercent >= 25) reasons.push("獲利較高");
    if (weightPercent >= 20) reasons.push("部位偏重");
    if (chipWeak) reasons.push("法人轉弱");
    if (level?.level === "高風險") reasons.push("風險分數偏高");
    return { action: "減碼", reason: reasons.join("、") || "先降低波動風險" };
  }

  if (
    profitPercent > -5 &&
    profitPercent < 15 &&
    weightPercent < 15 &&
    chipTotal !== null &&
    chipTotal > 0 &&
    (foreign === null || foreign >= 0) &&
    !marginRisk
  ) {
    if (chipTotal > 0) reasons.push("法人偏買");
    if (foreign === null || foreign >= 0) reasons.push("外資未轉弱");
    if (weightPercent < 15) reasons.push("部位仍可控");
    return { action: "可加碼", reason: reasons.join("、") };
  }

  if (profitPercent <= -8 || level?.level === "注意") {
    if (profitPercent <= -8) reasons.push("跌破成本");
    if (chipWeak) reasons.push("籌碼偏弱");
    return { action: "減碼", reason: reasons.join("、") || "先觀察是否續弱" };
  }

  if (profitPercent >= 18) {
    return { action: "續抱", reason: "已有獲利，留意分批停利點" };
  }

  return { action: "續抱", reason: "未達停損或減碼條件" };
};

const recommendProfessionalIntradayAction = (item, chip, margin, level) => {
  const profitPercent = Number(item?.profitPercent || 0);
  const weightPercent = Number(item?.weightPercent || 0);
  const chipTotal = chip?.available ? Number(chip.total || 0) : null;
  const foreign = chip?.available ? Number(chip.foreign || 0) : null;
  const marginChange = margin?.available ? Number(margin.marginChange || 0) : null;
  const chipWeak = chipTotal !== null && chipTotal < 0;
  const foreignWeak = foreign !== null && foreign < 0;
  const marginRisk = marginChange !== null && marginChange > 0 && profitPercent < 0;
  const chipStrong = chipTotal !== null && chipTotal > 0;
  const foreignStrong = foreign !== null && foreign >= 0;
  const chipUnknown = chipTotal === null && foreign === null;
  const negativeSignals = [chipWeak, foreignWeak, marginRisk, weightPercent >= 20].filter(Boolean).length;
  const reasons = [];

  if (profitPercent <= -20 && negativeSignals >= 2) {
    reasons.push("虧損已深且不是單一成本因素");
    if (chipWeak) reasons.push("三大法人偏賣");
    if (foreignWeak) reasons.push("外資偏賣");
    if (marginRisk) reasons.push("虧損中融資增加");
    if (weightPercent >= 20) reasons.push("部位占比過高");
    return { action: "停損", reason: reasons.join("；") };
  }

  if (profitPercent <= -12 && negativeSignals >= 2) {
    reasons.push("跌幅擴大且籌碼/資金面同步轉弱");
    if (chipWeak) reasons.push("三大法人賣超");
    if (foreignWeak) reasons.push("外資賣超");
    if (marginRisk) reasons.push("融資增加代表籌碼壓力升高");
    if (weightPercent >= 20) reasons.push("部位過重需先控風險");
    return { action: "減碼", reason: reasons.join("；") };
  }

  if (
    (profitPercent >= 25 && (chipWeak || weightPercent >= 18)) ||
    (weightPercent >= 22 && profitPercent >= 8)
  ) {
    if (profitPercent >= 25) reasons.push("獲利已高，優先保護獲利");
    if (weightPercent >= 18) reasons.push("部位占比偏高");
    if (chipWeak) reasons.push("法人開始偏賣");
    return { action: "減碼", reason: reasons.join("；") || "獲利與部位風險偏高" };
  }

  if (
    profitPercent >= -6 &&
    profitPercent <= 12 &&
    weightPercent < 12 &&
    chipStrong &&
    foreignStrong &&
    !marginRisk
  ) {
    return { action: "可加碼", reason: "法人偏買；外資未轉弱；部位占比仍可控" };
  }

  if (profitPercent <= -10) {
    reasons.push("低於成本但不能只因成本線賣出");
    if (chipUnknown) reasons.push("法人/外資資料不足，先觀察下一次籌碼");
    if (!chipWeak && !foreignWeak) reasons.push("未見法人與外資同步轉弱");
    if (!marginRisk) reasons.push("融資未形成明確惡化訊號");
    return { action: "續抱觀察", reason: reasons.join("；") };
  }

  if (profitPercent >= 18) {
    if (chipWeak || foreignWeak) {
      return { action: "續抱偏保守", reason: "已有獲利但法人/外資轉弱；可設移動停利，不急著一次出清" };
    }
    return { action: "續抱", reason: "仍有獲利且未見明確籌碼轉弱，續抱並追蹤停利點" };
  }

  if (chipWeak || foreignWeak || marginRisk) {
    if (chipWeak) reasons.push("法人偏賣");
    if (foreignWeak) reasons.push("外資偏賣");
    if (marginRisk) reasons.push("融資增加");
    return { action: "續抱偏保守", reason: `${reasons.join("；")}，但尚未達減碼條件` };
  }

  return { action: "續抱", reason: "價格、部位與籌碼未出現足夠明確的加碼或減碼訊號" };
};

const getIntradayAnalysisSnapshots = async (entries) =>
  Promise.all(
    entries.map(async ([code, position]) => {
      try {
        const quote = await fetchAlertYahooQuote(code, 2500);
        const price = Number(quote.regularMarketPrice);
        if (!Number.isFinite(price)) {
          throw new Error("報價無效");
        }
        const shares = Number(position.shares || 0);
        const averageCost = Number(position.averageCost || 0);
        const costValue = shares * averageCost;
        const marketValue = shares * price;
        const profit = marketValue - costValue;
        const profitPercent = costValue > 0 ? (profit / costValue) * 100 : 0;
        return {
          code,
          name: dailyName(code),
          shares,
          averageCost,
          price,
          costValue,
          marketValue,
          profit,
          profitPercent,
          error: false
        };
      } catch (error) {
        return {
          code,
          name: dailyName(code),
          shares: Number(position.shares || 0),
          error: true,
          errorMessage: error.message
        };
      }
    })
  );

const intradayAnalysisTotals = (snapshots) => {
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

const buildIntradayDecisionAnalysis = async (ownerKey, stockNameLookup = {}) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = [...portfolio.entries()];
  if (entries.length === 0) {
    return "盤中分析\n\n目前沒有持股資料。請先同步網頁資產表到 LINE。";
  }

  const snapshots = await getIntradayAnalysisSnapshots(entries);
  const totals = intradayAnalysisTotals(snapshots);
  if (totals.successful.length === 0) {
    return `盤中分析\n\n目前 ${entries.length} 檔持股報價都查詢失敗，暫時無法分析。`;
  }

  const tdcc = await getTdccShareholdingRowsByCode().catch((error) => {
    console.error("TDCC shareholding fetch failed for intraday decision analysis:", error.message);
    return { rowsByCode: new Map(), sourceDate: null };
  });
  const formatIntradayHolderLine = (holder) =>
    holder
      ? `大戶：400張+ ${formatShareholdingPercent(holder.bigPercent)}，千張+ ${formatShareholdingPercent(
          holder.megaPercent
        )}，散戶 ${formatShareholdingPercent(holder.retailPercent)}`
      : "大戶：TDCC 週資料不足";

  const rows = analysisItems(totals.successful).map((item) => ({
    ...item,
    weightPercent: totals.totalMarket > 0 ? (item.marketValue / totals.totalMarket) * 100 : 0
  }));
  const selected = [];
  const pushUnique = (item) => {
    if (item && !selected.some((saved) => saved.code === item.code)) {
      selected.push(item);
    }
  };
  [...rows].sort((a, b) => a.profitPercent - b.profitPercent).slice(0, 3).forEach(pushUnique);
  [...rows].sort((a, b) => b.marketValue - a.marketValue).slice(0, 2).forEach(pushUnique);
  [...rows].sort((a, b) => b.profitPercent - a.profitPercent).slice(0, 1).forEach(pushUnique);

  const analyses = await Promise.all(
    selected.slice(0, 4).map(async (item) => {
      const [chip, margin] = await Promise.all([
        fetchInstitutionalChipSummary(item.code),
        fetchMarginChipSummary(item.code)
      ]);
      const holder = summarizeShareholdingRows(tdcc.rowsByCode.get(item.code));
      const level = analysisLevelForHolding(item, chip, margin, item.weightPercent);
      const action = recommendProfessionalIntradayAction(item, chip, margin, level);
      return { item, chip, margin, holder, level, action };
    })
  );

  const analysesByCode = new Map(analyses.map((analysis) => [analysis.item.code, analysis]));
  const actionRows = [...rows]
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .map((item, index) => {
      const detailed = analysesByCode.get(item.code);
      const level = detailed?.level || analysisLevelForHolding(item, null, null, item.weightPercent);
      const action = detailed?.action || recommendProfessionalIntradayAction(item, null, null, level);
      return `${index + 1}. ${stockLabel(item.code, item.name)}：${action.action}｜${action.reason}`;
    })
    .join("\n");

  const warningRows = analyses
    .sort((a, b) => {
      const order = { "高風險": 0, "注意": 1, "可檢視停利": 2, "觀察": 3 };
      return order[a.level.level] - order[b.level.level] || a.item.profitPercent - b.item.profitPercent;
    })
    .map(({ item, chip, margin, holder, level, action }, index) => {
      const name = stockLabel(item.code, item.name || stockNameLookup[item.code]);
      return `${index + 1}. ${name}
等級：${level.level}
建議：${action.action}（${action.reason}）
持股損益：${signedMoney(item.profit)} (${signedPercent(item.profitPercent)})，占比 ${item.weightPercent.toFixed(1)}%
${chip.text}
${formatIntradayHolderLine(holder)}
${margin.text}
判斷：${level.reasons.join("、")}`;
    })
    .join("\n\n");

  const topLosers = [...rows]
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${signedMoney(item.profit)} (${signedPercent(item.profitPercent)})`)
    .join("\n");

  const topGainers = [...rows]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${stockLabel(item.code, item.name)} ${signedMoney(item.profit)} (${signedPercent(item.profitPercent)})`)
    .join("\n");

  const now = getTaipeiNow();
  return toLineSafeText(`盤中持股分析
${now.dateKey} ${now.timeKey}

整體
持股檔數：${entries.length} 檔
總市值：${formatBriefMoney(totals.totalMarket)} 元
總成本：${formatBriefMoney(totals.totalCost)} 元
未實現損益：${signedMoney(totals.totalProfit)} (${signedPercent(totals.totalPercent)})
報價失敗：${totals.failedCount} 檔

全部持股建議
${actionRows}

需要優先看的持股
${warningRows}

拖累前三
${topLosers}

貢獻前三
${topGainers}

籌碼動向
本版已納入外資、投信、自營商與融資融券；真正的大戶/集保級距屬於週資料，尚未接入，因此不拿來做盤中即時判斷。

提醒：這是風險健檢，不是買賣建議。賣出前仍要看你的資金需求、停損停利規則與是否有新交易尚未同步。`);
};

const checkAndPushIntradayDecisionAnalysis = async (force = false) => {
  if (!hasPortfolioDb || !INTRADAY_ANALYSIS_ENABLED || INTRADAY_ANALYSIS_TIMES.length === 0) {
    return [];
  }

  const now = getTaipeiNow();
  if (!force && (now.weekday === "Sat" || now.weekday === "Sun")) {
    return [];
  }
  if (!force && !INTRADAY_ANALYSIS_TIMES.includes(now.timeKey)) {
    return [];
  }

  const ownerKeys = await getPortfolioOwnerKeys();
  const results = [];
  for (const ownerKey of ownerKeys) {
    const pushKey = `${now.dateKey}|${now.timeKey}|${ownerKey}`;
    if (!force && intradayAnalysisPushLog.has(pushKey)) {
      continue;
    }
    if (shouldSkipLinePush(ownerKey, "scheduled", LINE_SCHEDULED_PUSH_MIN_GAP_MS, force)) {
      results.push({ ownerKey, pushed: false, skipped: "cooldown" });
      continue;
    }

    const text = toLineSafeText(await buildIntradayDecisionAnalysis(ownerKey));
    await client.pushMessage(ownerKey, {
      type: "text",
      text
    });
    markLinePush(ownerKey, "scheduled");
    intradayAnalysisPushLog.add(pushKey);
    results.push({ ownerKey, pushed: true });
  }
  return results;
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

  const textFromCodes = (...codes) => String.fromCharCode(...codes);
  const cmdVersion = textFromCodes(29256, 26412);
  const cmdSummaryTest = textFromCodes(25688, 35201, 28204, 35430);
  const cmdCostSummary = textFromCodes(25104, 26412, 30064, 24120, 25688, 35201);
  const cmdShortSummary = textFromCodes(30064, 24120, 25688, 35201);

  if (marketInput === cmdVersion) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: textFromCodes(9989, 32, 29256, 26412, 30906, 35469) + "\n" + BOT_BUILD_VERSION + "\n\n" +
        textFromCodes(22914, 26524, 20320, 30475, 24471, 21040, 36889, 21063, 65292, 20195, 34920, 24050, 37096, 32626, 26368, 26032, 29256)
    });
  }

  if (marketInput === cmdSummaryTest) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: textFromCodes(9989, 32, 25688, 35201, 28204, 35430, 32, 79, 75, 65306, 76, 73, 78, 69, 32, 25351, 20196, 26377, 36914, 21040, 26368, 26032, 29256, 31243, 24335)
    });
  }

  if ([cmdCostSummary, cmdShortSummary].includes(marketInput)) {
    const timeout = new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            textFromCodes(9888, 65039, 32, 25104, 26412, 30064, 24120, 25688, 35201, 26597, 35426, 36926, 26178) +
              "\n\n" +
              textFromCodes(20195, 34920, 31243, 24335, 26377, 25910, 21040, 25351, 20196, 65292, 20294, 36039, 26009, 24235, 26597, 35426, 22826, 24930, 25110, 32, 83, 117, 112, 97, 98, 97, 115, 101, 32, 26283, 26178, 21345, 20303) +
              "\n" + textFromCodes(35531, 20808, 36664, 20837, 65306, 25104, 26412, 30064, 24120, 20998, 32026, 26597, 30475) +
              "\n" + textFromCodes(25110, 31245, 24460, 20877, 35430, 65306, 30064, 24120, 25688, 35201)
          ),
        5500
      )
    );

    try {
      const summaryText = await Promise.race([
        buildTieredCostAlertSummary(event.source?.userId || "default"),
        timeout
      ]);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: summaryText
      });
    } catch (error) {
      console.error("cost alert summary failed:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          textFromCodes(9888, 65039, 32, 25104, 26412, 30064, 24120, 25688, 35201, 26597, 35426, 22833, 25943, 65292, 20294, 31243, 24335, 26377, 25910, 21040, 25351, 20196) +
          "\n" + textFromCodes(35531, 21040, 32, 82, 97, 105, 108, 119, 97, 121, 32, 68, 101, 112, 108, 111, 121, 32, 76, 111, 103, 115, 32, 26597, 30475, 32, 99, 111, 115, 116, 32, 97, 108, 101, 114, 116, 32, 115, 117, 109, 109, 97, 114, 121, 32, 102, 97, 105, 108, 101, 100, 32, 24460, 38754, 30340, 37679, 35492)
      });
    }
  }

  const lineAgentIntents = parseLineAgentIntents(marketInput);
  if (lineAgentIntents.length > 0) {
    try {
      const ownerKey = event.source?.userId || "default";
      const replies = [];
      for (const intent of lineAgentIntents) {
        rememberLineAgentInteraction(ownerKey, intent);
        const replyText = await buildLineAgentReply(intent, ownerKey);
        if (replyText) replies.push(replyText);
      }
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: toLineSafeText(replies.join("\n\n---\n\n"))
      });
    } catch (error) {
      console.error("line agent router failed:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `AI 助理暫時無法完成這個指令：${serviceErrorMessage(error)}\n\n請稍後再試，或改問「AI助理」查看可用指令。`
      });
    }
  }

  if (["盤中分析", "持股分析", "盤中持股分析", "今日持股分析"].includes(marketInput)) {
    try {
      const ownerKey = event.source?.userId || "default";
      const text = await buildIntradayDecisionAnalysis(ownerKey, stockNames);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: toLineSafeText(text)
      });
    } catch (error) {
      console.error("intraday decision analysis failed:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "盤中分析產生失敗，請稍後再試，或到 Railway Deploy Logs 查看 intraday decision analysis failed 後面的錯誤。"
      });
    }
  }

  if (marketInput === "??") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "? ????\n" + BOT_BUILD_VERSION + "\n\n??????????? GitHub/Railway ???????"
    });
  }

  if (marketInput === "????") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "? ???? OK?LINE ???????????"
    });
  }

  if (["??????", "????"].includes(marketInput)) {
    const timeout = new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            "?? ??????????\n\n??????????????????? Supabase ?????\n?????????????\n??????????"
          ),
        5500
      )
    );

    try {
      const summaryText = await Promise.race([
        buildTieredCostAlertSummary(event.source?.userId || "default"),
        timeout
      ]);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: summaryText
      });
    } catch (error) {
      console.error("????????:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "?? ????????????????????\n?? Railway Deploy Logs ??????????????????"
      });
    }
  }


  if (["系統健檢", "系統狀態", "健檢"].includes(marketInput)) {
    try {
      const diagnostics = await buildSystemDiagnostics();
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: buildSystemDiagnosticsText(diagnostics)
      });
    } catch (error) {
      console.error("System diagnostics failed:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `系統健檢失敗：${serviceErrorMessage(error)}`
      });
    }
  }


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
📊 交易報表：交易月報 / 交易季報 / 交易年報
📈 每月交易量：每月交易量 / 交易量
📡 持股行動雷達：持股行動雷達 / 每日籌碼
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
📥 匯入狀態：交易匯入狀態
🎁 股息紀錄：股息紀錄
💰 已實現損益：已實現損益

🔔 新增提醒：提醒+台積電 2500 以上
🔔 停損提醒：提醒+台積電 2200 以下
🎯 成本異常：成本異常設定 30
📋 成本異常查看：成本異常查看
🗑️ 成本異常刪除：成本異常刪除 30
📋 提醒列表：提醒列表
🔎 檢查提醒：檢查提醒
🗑️ 移除提醒：提醒-台積電

🗓️ 今日總結：今日總結
📡 盤中分析：盤中分析 / 盤中快訊
🏦 大戶週報：大戶動向 / 集保級距
🚨 盤中異常：盤中異常 / 異常快訊
⚙️ 異常門檻：異常設定 3 3000 8000
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

        const completion = await getOpenAIClient().chat.completions.create({
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
"3552": "同致",
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
"7769": "鴻勁",
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

const dailyTimeMatch = marketInput.match(/^每日報告時間\s+(.+)$/);
if (dailyTimeMatch) {
  const times = parseDailyReportTimes(dailyTimeMatch[1]);
  if (!times) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：每日報告時間 09:00,14:35"
    });
  }

  const setting = await saveDailyReportSetting(watchlistKey, { times });
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已更新每日報告時間
推送時間：${setting.times.join(", ")}
推送模式：${setting.mode === "full" ? "完整" : "精簡"}
目前啟用：${setting.enabled ? "是" : "否"}`
  });
}

const dailyModeMatch = marketInput.match(/^每日報告模式\s+(.+)$/);
if (dailyModeMatch) {
  const mode = normalizeDailyReportMode(dailyModeMatch[1]);
  if (!mode) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：每日報告模式 精簡 或 每日報告模式 完整"
    });
  }

  const setting = await saveDailyReportSetting(watchlistKey, { mode });
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已更新每日報告模式
推送模式：${setting.mode === "full" ? "完整" : "精簡"}
推送時間：${setting.times.join(", ") || "未設定"}
目前啟用：${setting.enabled ? "是" : "否"}`
  });
}

if (marketInput === "每日報告開啟" || marketInput === "每日報告關閉") {
  const setting = await saveDailyReportSetting(watchlistKey, {
    enabled: marketInput === "每日報告開啟"
  });
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已${setting.enabled ? "開啟" : "關閉"}每日自動報告
推送時間：${setting.times.join(", ") || "未設定"}
推送模式：${setting.mode === "full" ? "完整" : "精簡"}`
  });
}

if (["每日報告", "自動日報", "盤後日報", "每日報告完整"].includes(marketInput)) {
  try {
    const report = await buildDailyAutoPortfolioReport(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: report
    });
  } catch (error) {
    console.error("daily report command failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "每日報告產生失敗，請到 Railway Deploy Logs 查看 daily report command failed 後面的錯誤。"
    });
  }
}

if (marketInput === "每日報告精簡") {
  try {
    const report = await buildDailyCompactPortfolioReport(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: report
    });
  } catch (error) {
    console.error("daily compact report command failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "每日精簡報告產生失敗，請到 Railway Deploy Logs 查看 daily compact report command failed 後面的錯誤。"
    });
  }
}

if (marketInput === "每日報告設定") {
  const setting = await getDailyReportSetting(watchlistKey);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📅 每日自動報告設定

目前啟用：${setting.enabled ? "是" : "否"}
推送時間：${setting.times.join(", ") || "未設定"}
推送模式：${setting.mode === "full" ? "完整" : "精簡"}
檢查間隔：${Math.round(DAILY_REPORT_INTERVAL_MS / 1000)} 秒

手動查看：每日報告完整
精簡查看：每日報告精簡
手動推送：每日報告推送
網址測試：/daily-report/check

LINE 設定：
每日報告時間 09:00,14:35
每日報告模式 精簡
每日報告模式 完整
每日報告開啟
每日報告關閉`
  });
}

if (marketInput === "每日報告推送") {
  try {
    const results = await checkAndPushDailyReports(true, watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已嘗試推送每日報告
推送筆數：${results.length}`
    });
  } catch (error) {
    console.error("manual daily report push failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "每日報告推送失敗，請到 Railway Deploy Logs 查看 manual daily report push failed 後面的錯誤。"
    });
  }
}

if (["大戶動向", "集保級距", "大戶週報", "集保週報"].includes(marketInput)) {
  try {
    const report = await buildMajorHolderWeeklyReport(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: report
    });
  } catch (error) {
    console.error("major holder weekly report failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "大戶週報產生失敗，請稍後再試，或到 Railway Deploy Logs 查看 major holder weekly report failed 後面的錯誤。"
    });
  }
}

if (["每日籌碼", "每日籌碼動向", "每日大戶外資", "大戶外資動向", "持股籌碼", "持股行動雷達", "行動雷達"].includes(marketInput)) {
  try {
    const report = await buildDailyChipMovementReport(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: report
    });
  } catch (error) {
    console.error("daily chip movement report failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "每日籌碼動向產生失敗，請稍後再試，或到 Railway Deploy Logs 查看 daily chip movement report failed 後面的錯誤。"
    });
  }
}

if (marketInput === "每日籌碼推送") {
  try {
    const results = await checkAndPushDailyChipMovementReports(true, watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已嘗試推送每日籌碼動向
推送筆數：${results.length}`
    });
  } catch (error) {
    console.error("manual daily chip movement push failed:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "每日籌碼動向推送失敗，請到 Railway Deploy Logs 查看 manual daily chip movement push failed 後面的錯誤。"
    });
  }
}

function resolveStockCode(input) {
  const normalized = String(input || "").trim();
  return reverseStockNames[normalized] || normalized;
}

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

const parseTradeDate = (value) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
};

const currentQuarter = (month) => Math.floor((month - 1) / 3) + 1;

const tradePeriodRange = (type, input = "") => {
  const now = new Date();
  const fallbackYear = now.getFullYear();
  const fallbackMonth = now.getMonth() + 1;
  const fallbackQuarter = currentQuarter(fallbackMonth);
  const text = input.trim();

  if (type === "month") {
    const match = text.match(/(\d{4})[-/](\d{1,2})/);
    const year = match ? Number(match[1]) : fallbackYear;
    const month = match ? Number(match[2]) : fallbackMonth;
    return {
      label: `${year}-${String(month).padStart(2, "0")}`,
      includes: (date) => date.year === year && date.month === month
    };
  }

  if (type === "quarter") {
    const match = text.match(/(\d{4})\s*[Qq季]?\s*([1-4])/);
    const year = match ? Number(match[1]) : fallbackYear;
    const quarter = match ? Number(match[2]) : fallbackQuarter;
    return {
      label: `${year} Q${quarter}`,
      includes: (date) =>
        date.year === year && currentQuarter(date.month) === quarter
    };
  }

  const match = text.match(/(\d{4})/);
  const year = match ? Number(match[1]) : fallbackYear;
  return {
    label: `${year}`,
    includes: (date) => date.year === year
  };
};

const topTradeRows = (items, stockNames, limit = 3) =>
  [...items.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, stockNames[item.code])}：${formatMoney(
          item.shares
        )} 股｜${formatMoney(item.amount)} 元`
    );

const tradeFingerprint = (trade) =>
  [
    formatTradeDate(trade.tradedAt),
    trade.type,
    trade.code,
    Number(trade.shares || 0).toFixed(4),
    Number(trade.price || 0).toFixed(4),
    Number(trade.fee || 0).toFixed(4),
    Number(trade.tax || 0).toFixed(4)
  ].join("|");

const buildTradeImportStatus = async (ownerKey) => {
  const trades = await getAllTrades(ownerKey);
  if (trades.length === 0) {
    return `📥 交易匯入狀態

目前沒有交易紀錄。

可輸入「交易匯入格式」查看批次匯入格式。`;
  }

  const datedTrades = trades
    .map((trade) => ({
      ...trade,
      dateText: formatTradeDate(trade.tradedAt)
    }))
    .filter((trade) => /^\d{4}-\d{2}-\d{2}$/.test(trade.dateText))
    .sort((a, b) => a.dateText.localeCompare(b.dateText));
  const firstDate = datedTrades[0]?.dateText || "未知";
  const lastDate = datedTrades[datedTrades.length - 1]?.dateText || "未知";
  const currentYear = String(new Date().getFullYear());
  const buyCount = trades.filter((trade) => trade.type === "buy").length;
  const sellCount = trades.filter((trade) => trade.type === "sell").length;
  const thisYearCount = datedTrades.filter((trade) =>
    trade.dateText.startsWith(currentYear)
  ).length;
  const feeTotal = trades.reduce((sum, trade) => sum + Number(trade.fee || 0), 0);
  const taxTotal = trades.reduce((sum, trade) => sum + Number(trade.tax || 0), 0);

  return `📥 交易匯入狀態

交易總筆數：${trades.length} 筆
最早交易日：${firstDate}
最新交易日：${lastDate}
${currentYear} 年交易：${thisYearCount} 筆
買進筆數：${buyCount} 筆
賣出筆數：${sellCount} 筆
手續費合計：${formatMoney(feeTotal)} 元
交易稅合計：${formatMoney(taxTotal)} 元

提醒：匯入交易時，完全相同的日期、買賣、代號、股數、價格、手續費、交易稅會自動跳過。`;
};

const buildTradePeriodReport = async (ownerKey, type, input, stockNames) => {
  const range = tradePeriodRange(type, input);
  const trades = await getAllTrades(ownerKey);
  const matched = trades.filter((trade) => {
    const date = parseTradeDate(trade.tradedAt);
    return date && range.includes(date);
  });

  const reportTitle =
    type === "month" ? "交易月報" : type === "quarter" ? "交易季報" : "交易年報";

  if (matched.length === 0) {
    return `📊 ${reportTitle} ${range.label}

目前沒有此期間的交易紀錄。

可用格式：
交易月報 2026-06
交易季報 2026 Q2
交易年報 2026`;
  }

  const buyByCode = new Map();
  const sellByCode = new Map();
  const summary = matched.reduce(
    (acc, trade) => {
      const amount = Number(trade.shares) * Number(trade.price);
      const target = trade.type === "buy" ? buyByCode : sellByCode;
      const saved = target.get(trade.code) || {
        code: trade.code,
        shares: 0,
        amount: 0
      };
      saved.shares += Number(trade.shares || 0);
      saved.amount += amount;
      target.set(trade.code, saved);

      acc.fee += Number(trade.fee || 0);
      acc.tax += Number(trade.tax || 0);
      if (trade.type === "buy") {
        acc.buyCount += 1;
        acc.buyAmount += amount;
        acc.buyShares += Number(trade.shares || 0);
      } else {
        acc.sellCount += 1;
        acc.sellAmount += amount;
        acc.sellShares += Number(trade.shares || 0);
        acc.realizedProfit += Number(trade.realizedProfit || 0);
      }
      return acc;
    },
    {
      buyCount: 0,
      sellCount: 0,
      buyAmount: 0,
      sellAmount: 0,
      buyShares: 0,
      sellShares: 0,
      fee: 0,
      tax: 0,
      realizedProfit: 0
    }
  );

  const netCashFlow = summary.sellAmount - summary.buyAmount - summary.fee - summary.tax;
  const buyRows = topTradeRows(buyByCode, stockNames);
  const sellRows = topTradeRows(sellByCode, stockNames);

  return `📊 ${reportTitle} ${range.label}

交易筆數：${matched.length} 筆
買進：${summary.buyCount} 筆｜${formatMoney(summary.buyShares)} 股｜${formatMoney(
    summary.buyAmount
  )} 元
賣出：${summary.sellCount} 筆｜${formatMoney(summary.sellShares)} 股｜${formatMoney(
    summary.sellAmount
  )} 元
手續費：${formatMoney(summary.fee)} 元
交易稅：${formatMoney(summary.tax)} 元
交易現金流：${profitSign(netCashFlow)}${formatMoney(netCashFlow)} 元
已實現損益：${profitSign(summary.realizedProfit)}${formatMoney(
    summary.realizedProfit
  )} 元

買進金額前 3：
${buyRows.length ? buyRows.join("\n") : "無"}

賣出金額前 3：
${sellRows.length ? sellRows.join("\n") : "無"}

提醒：已實現損益以交易紀錄中的賣出損益為準；批次匯入若未填賣出損益，會以 0 計。`;
};

const buildMonthlyTradeVolumeReport = async (ownerKey, stockNames, limit = 12) => {
  const trades = await getAllTrades(ownerKey);
  const monthly = new Map();

  for (const trade of trades) {
    const date = parseTradeDate(trade.tradedAt);
    if (!date) continue;
    const monthKey = `${date.year}-${String(date.month).padStart(2, "0")}`;
    const amount = Number(trade.shares || 0) * Number(trade.price || 0);
    const row =
      monthly.get(monthKey) || {
        month: monthKey,
        count: 0,
        buyCount: 0,
        sellCount: 0,
        buyAmount: 0,
        sellAmount: 0,
        fee: 0,
        tax: 0,
        realizedProfit: 0,
        byCode: new Map()
      };
    row.count += 1;
    row.fee += Number(trade.fee || 0);
    row.tax += Number(trade.tax || 0);
    if (trade.type === "buy") {
      row.buyCount += 1;
      row.buyAmount += amount;
    } else {
      row.sellCount += 1;
      row.sellAmount += amount;
      row.realizedProfit += Number(trade.realizedProfit || 0);
    }
    const saved = row.byCode.get(trade.code) || {
      code: trade.code,
      shares: 0,
      amount: 0
    };
    saved.shares += Number(trade.shares || 0);
    saved.amount += amount;
    row.byCode.set(trade.code, saved);
    monthly.set(monthKey, row);
  }

  const rows = [...monthly.values()]
    .map((row) => ({
      ...row,
      volume: row.buyAmount + row.sellAmount,
      netCashFlow: row.sellAmount - row.buyAmount - row.fee - row.tax,
      topRows: topTradeRows(row.byCode, stockNames, 1)
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, limit);

  if (rows.length === 0) {
    return `📊 每月交易量

目前沒有可統計的交易紀錄。`;
  }

  const totalVolume = rows.reduce((sum, row) => sum + row.volume, 0);
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const mostActive = [...rows].sort((a, b) => b.volume - a.volume)[0];
  const lines = rows.map(
    (row) => `${row.month}
交易量：${formatMoney(row.volume)} 元｜${row.count} 筆
買進：${formatMoney(row.buyAmount)} 元 / ${row.buyCount} 筆
賣出：${formatMoney(row.sellAmount)} 元 / ${row.sellCount} 筆
現金流：${profitSign(row.netCashFlow)}${formatMoney(row.netCashFlow)} 元｜已實現 ${profitSign(
      row.realizedProfit
    )}${formatMoney(row.realizedProfit)} 元
最大標的：${row.topRows[0] || "無"}`
  );

  return `📊 每月交易量

最近 ${rows.length} 個有交易月份
總交易量：${formatMoney(totalVolume)} 元
交易筆數：${totalCount} 筆
最活躍月份：${mostActive.month}｜${formatMoney(mostActive.volume)} 元

${lines.join("\n\n")}

看法：交易量高的月份代表你資金調整比較多，可搭配「月盈虧」看交易是否真的有提高績效。`;
};

const formatPortfolioSnapshot = (item) => {
  if (item.error) {
    return `${stockLabel(item.code, item.name)}：即時損益查詢失敗`;
  }

  const sign = profitSign(item.profit);
  return `${stockLabel(item.code, item.name)}
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

const buildIntradayAnomalyState = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const entries = analysisEntries([...portfolio.entries()]);
  if (entries.length === 0) {
    return null;
  }

  const snapshots = await getPortfolioSnapshots(entries, {
    timeoutMs: 2500,
    raceMs: 3500
  });
  const totals = portfolioTotals(snapshots);
  const stocks = new Map(
    totals.successful.map((item) => [
      item.code,
      {
        code: item.code,
        name: item.name,
        price: item.price,
        profit: item.profit,
        profitPercent: item.profitPercent,
        marketValue: item.marketValue
      }
    ])
  );

  return {
    checkedAt: new Date().toISOString(),
    entriesCount: entries.length,
    failedCount: totals.failedCount,
    totalMarket: totals.totalMarket,
    totalProfit: totals.totalProfit,
    totalPercent: totals.totalPercent,
    stocks
  };
};

const formatIntradayAnomalyRow = (item, index) =>
  `${index + 1}. ${stockLabel(item.code, item.name)}：${profitSign(
    item.profitPercent
  )}${formatPercent(item.profitPercent)}%，損益 ${profitSign(
    item.profit
  )}${formatMoney(item.profit)} 元
變動：${profitSign(item.profitPercentDelta)}${formatPercent(
    item.profitPercentDelta
  )} 個百分點，${profitSign(item.profitDelta)}${formatMoney(item.profitDelta)} 元`;

const evaluateIntradayAnomalies = async (ownerKey, options = {}) => {
  const settings = getIntradayAnomalySettings(ownerKey);
  const state = await buildIntradayAnomalyState(ownerKey);
  if (!state) {
    return {
      shouldPush: false,
      text: "目前沒有持股資料，無法建立盤中異常提醒。"
    };
  }

  const previous = intradayAnomalyBaselines.get(ownerKey);
  intradayAnomalyBaselines.set(ownerKey, state);

  if (!previous || options.resetBaseline) {
    return {
      shouldPush: false,
      text: `📣 盤中異常提醒已建立基準

持股檔數：${state.entriesCount} 檔
總市值：${formatMoney(state.totalMarket)} 元
未實現損益：${profitSign(state.totalProfit)}${formatMoney(state.totalProfit)} 元
未實現報酬率：${profitSign(state.totalPercent)}${formatPercent(state.totalPercent)}%

之後若超過門檻會自動提醒：
單檔報酬率變動 ${formatPercent(settings.stockMovePercent)}%
單檔損益變動 ${formatMoney(settings.stockProfitDelta)} 元
總損益變動 ${formatMoney(settings.totalProfitDelta)} 元`
    };
  }

  const stockAnomalies = [];
  for (const item of state.stocks.values()) {
    const old = previous.stocks.get(item.code);
    if (!old) {
      continue;
    }

    const profitDelta = item.profit - old.profit;
    const profitPercentDelta = item.profitPercent - old.profitPercent;
    if (
      Math.abs(profitPercentDelta) >= settings.stockMovePercent ||
      Math.abs(profitDelta) >= settings.stockProfitDelta
    ) {
      stockAnomalies.push({
        ...item,
        profitDelta,
        profitPercentDelta
      });
    }
  }

  const totalProfitDelta = state.totalProfit - previous.totalProfit;
  const totalPercentDelta = state.totalPercent - previous.totalPercent;
  const totalTriggered =
    Math.abs(totalProfitDelta) >= settings.totalProfitDelta;

  if (!totalTriggered && stockAnomalies.length === 0) {
    return {
      shouldPush: false,
      text: `📣 盤中異常檢查

目前沒有超過門檻的異常波動。

總市值：${formatMoney(state.totalMarket)} 元
未實現損益：${profitSign(state.totalProfit)}${formatMoney(state.totalProfit)} 元
本次總損益變動：${profitSign(totalProfitDelta)}${formatMoney(totalProfitDelta)} 元
報酬率變動：${profitSign(totalPercentDelta)}${formatPercent(totalPercentDelta)} 個百分點`
    };
  }

  const sortedAnomalies = stockAnomalies
    .sort((a, b) => Math.abs(b.profitDelta) - Math.abs(a.profitDelta))
    .slice(0, 6);
  const now = getTaipeiNow();
  return {
    shouldPush: true,
    text: `🚨 盤中持股異常提醒
${now.dateKey} ${now.timeKey}

總市值：${formatMoney(state.totalMarket)} 元
未實現損益：${profitSign(state.totalProfit)}${formatMoney(state.totalProfit)} 元
本次總損益變動：${profitSign(totalProfitDelta)}${formatMoney(totalProfitDelta)} 元
報酬率變動：${profitSign(totalPercentDelta)}${formatPercent(totalPercentDelta)} 個百分點

${totalTriggered ? "⚠️ 總損益變動已超過門檻。\n\n" : ""}異常個股：
${
  sortedAnomalies.length
    ? sortedAnomalies.map(formatIntradayAnomalyRow).join("\n\n")
    : "無單檔超過門檻。"
}${
      state.failedCount > 0
        ? `\n\n提醒：${state.failedCount} 檔報價失敗，未列入本次判斷。`
        : ""
    }

提醒：這是盤中估算，用來抓劇烈變化，不是買賣建議。`
  };
};

const checkAndPushIntradayAnomalies = async (force = false, onlyOwnerKey = null) => {
  if (!hasPortfolioDb || !INTRADAY_ANOMALY_ENABLED) {
    return [];
  }

  const ownerKeys = onlyOwnerKey ? [onlyOwnerKey] : await getPortfolioOwnerKeys();
  const results = [];
  for (const ownerKey of ownerKeys) {
    const result = await evaluateIntradayAnomalies(ownerKey);
    results.push({ ownerKey, ...result });
    if (!result.shouldPush) {
      continue;
    }

    const lastPushedAt = intradayAnomalyPushLog.get(ownerKey) || 0;
    if (!force && Date.now() - lastPushedAt < INTRADAY_ANOMALY_COOLDOWN_MS) {
      continue;
    }
    if (shouldSkipLinePush(ownerKey, "scheduled", LINE_SCHEDULED_PUSH_MIN_GAP_MS, force)) {
      continue;
    }

    await client.pushMessage(ownerKey, {
      type: "text",
      text: result.text
    });
    markLinePush(ownerKey, "scheduled");
    intradayAnomalyPushLog.set(ownerKey, Date.now());
  }
  return results;
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
  const evaluatedPositions = analysisItems(last.positions || []);
  const strongest = [...evaluatedPositions]
    .sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0))
    .slice(0, 3)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, item.name || stockNames[item.code])}：${profitSign(item.profit)}${formatMoney(item.profit)} 元`
    )
    .join("\n");
  const weakest = [...evaluatedPositions]
    .sort((a, b) => Number(a.profit || 0) - Number(b.profit || 0))
    .slice(0, 3)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, item.name || stockNames[item.code])}：${profitSign(item.profit)}${formatMoney(item.profit)} 元`
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

const tradeReportMatch = userMessage
  .trim()
  .match(/^(交易月報|交易季報|交易年報)(?:\s+(.+))?$/);
if (tradeReportMatch) {
  const reportTypeMap = {
    交易月報: "month",
    交易季報: "quarter",
    交易年報: "year"
  };
  const text = await buildTradePeriodReport(
    watchlistKey,
    reportTypeMap[tradeReportMatch[1]],
    tradeReportMatch[2] || "",
    stockNames
  );
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

if (["每月交易量", "月交易量", "交易量"].includes(userMessage.trim())) {
  const text = await buildMonthlyTradeVolumeReport(watchlistKey, stockNames);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

if (userMessage.trim() === "交易匯入狀態" || userMessage.trim() === "交易狀態") {
  const text = await buildTradeImportStatus(watchlistKey);
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
        `${index + 1}. ${stockLabel(row.code, stockNames[row.code])}：${
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
    text: `💼 已儲存持股：${stockLabel(code, stockNames[code])}
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
    text: `🗑️ 已移除持股：${stockLabel(code, stockNames[code])}`
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
    text: `🔔 已新增價格提醒：${stockLabel(code, stockNames[code])}
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
    text: `🗑️ 已移除價格提醒：${stockLabel(code, stockNames[code])}`
  });
}

const tieredCostSetMatch = userMessage.trim().match(/^成本異常分級(?:\s+(.+))?$/);
if (tieredCostSetMatch) {
  const percents = parseCostTierPercents(tieredCostSetMatch[1]);
  if (percents.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：成本異常分級 15 30 50"
    });
  }

  try {
    const rows = await setupTieredCostAlerts(watchlistKey, percents);
    if (rows.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "目前沒有可套用的持股成本，無法建立分級提醒。"
      });
    }

    const sample = rows
      .slice(0, 8)
      .map(
        (row, index) =>
          `${index + 1}. ${stockLabel(row.code, stockNames[row.code])} ${formatMoney(
            row.percent
          )}% ${costTierLabel(row.percent)}\n上線：${row.upperPrice} 元｜下線：${row.lowerPrice} 元`
      )
      .join("\n\n");
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `🎯 已建立成本異常分級提醒

分級：${percents.map((percent) => `${formatMoney(percent)}%`).join(" / ")}
套用持股：${new Set(rows.map((row) => row.code)).size} 檔
提醒總數：${rows.length * 2} 筆

${sample}${rows.length > 8 ? `\n\n...還有 ${rows.length - 8} 組` : ""}

查看可輸入：成本異常分級查看
刪除可輸入：成本異常分級刪除`
    });
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料表還沒建立。請先到 Supabase SQL Editor 執行 cost_band_alerts.sql，再重新輸入：成本異常分級 15 30 50"
      });
    }
    throw error;
  }
}

if (userMessage.trim() === "成本異常分級查看") {
  try {
    const text = await buildTieredCostAlertStatus(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text
    });
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料表還沒建立。請先到 Supabase SQL Editor 執行 cost_band_alerts.sql。"
      });
    }
    throw error;
  }
}

if (["成本異常摘要", "異常摘要"].includes(userMessage.trim())) {
  try {
    const text = await buildTieredCostAlertSummary(watchlistKey);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text
    });
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料表還沒建立。請先到 Supabase SQL Editor 執行 cost_band_alerts.sql。"
      });
    }
    throw error;
  }
}

const tieredCostDeleteMatch = userMessage.trim().match(/^成本異常分級刪除(?:\s+(.+))?$/);
if (tieredCostDeleteMatch) {
  const percents = tieredCostDeleteMatch[1]
    ? parseCostTierPercents(tieredCostDeleteMatch[1], [])
    : [];
  let result;
  try {
    result = await deleteTieredCostAlerts(watchlistKey, percents);
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料表還沒建立。請先到 Supabase SQL Editor 執行 cost_band_alerts.sql。"
      });
    }
    throw error;
  }
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已刪除成本異常分級提醒

刪除範圍：${percents.length ? percents.map((percent) => `${formatMoney(percent)}%`).join(" / ") : "全部分級"}
處理提醒：約 ${result.deleted} 筆

重建可輸入：成本異常分級 15 30 50`
  });
}

const tieredCostRebuildMatch = userMessage.trim().match(/^成本異常分級重建(?:\s+(.+))?$/);
if (tieredCostRebuildMatch) {
  const percents = parseCostTierPercents(tieredCostRebuildMatch[1]);
  let rows;
  try {
    await deleteTieredCostAlerts(watchlistKey, percents);
    rows = await setupTieredCostAlerts(watchlistKey, percents);
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.data?.code === "PGRST205") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "資料表還沒建立。請先到 Supabase SQL Editor 執行 cost_band_alerts.sql。"
      });
    }
    throw error;
  }
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `♻️ 已重建成本異常分級提醒

分級：${percents.map((percent) => `${formatMoney(percent)}%`).join(" / ")}
套用持股：${new Set(rows.map((row) => row.code)).size} 檔
提醒總數：${rows.length * 2} 筆`
  });
}

const costBandAlertMatch = userMessage
  .trim()
  .match(/^成本異常設定(?:\s+(\d+(?:\.\d+)?))?$/);
if (costBandAlertMatch) {
  const percent = Number(costBandAlertMatch[1] || 30);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：成本異常設定 30"
    });
  }

  const rows = await setupCostBandAlerts(watchlistKey, percent);
  if (rows.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法建立成本異常提醒。"
    });
  }

  const preview = rows
    .slice(0, 8)
    .map(
      (row, index) =>
        `${index + 1}. ${stockLabel(row.code, stockNames[row.code])}
成本：${row.averageCost} 元
上緣：${row.upperPrice} 元｜下緣：${row.lowerPrice} 元`
    )
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🎯 已建立成本異常提醒

套用持股：${rows.length} 檔
提醒區間：平均成本 ±${formatPercent(percent)}%
提醒總數：${rows.length * 2} 筆

${preview}${
      rows.length > 8 ? `\n\n...另有 ${rows.length - 8} 檔已設定。` : ""
    }

提醒：若股價碰到上緣或下緣，LINE 會自動跳出到價通知，該筆提醒會自動關閉。`
  });
}

const costBandViewMatch = userMessage
  .trim()
  .match(/^成本異常查看(?:\s+(\d+(?:\.\d+)?))?$/);
if (costBandViewMatch) {
  const percent = Number(costBandViewMatch[1] || 30);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：成本異常查看 30"
    });
  }

  const rows = await getCostBandAlertRows(watchlistKey, percent);
  if (rows.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有持股資料，無法查看成本異常提醒。"
    });
  }

  const activeCount = rows.reduce(
    (sum, row) => sum + (row.upperActive ? 1 : 0) + (row.lowerActive ? 1 : 0),
    0
  );
  const preview = rows
    .slice(0, 10)
    .map(
      (row, index) =>
        `${index + 1}. ${stockLabel(row.code, stockNames[row.code])}
成本：${row.averageCost} 元
上緣：${row.upperPrice} 元 ${row.upperActive ? "✅" : "未啟用"}
下緣：${row.lowerPrice} 元 ${row.lowerActive ? "✅" : "未啟用"}`
    )
    .join("\n\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📋 成本異常提醒狀態

檢查區間：平均成本 ±${formatPercent(percent)}%
持股檔數：${rows.length} 檔
已啟用提醒：${activeCount} / ${rows.length * 2} 筆

${preview}${
      rows.length > 10 ? `\n\n...另有 ${rows.length - 10} 檔。` : ""
    }

重建可輸入：成本異常重建 ${formatMoney(percent)}
刪除可輸入：成本異常刪除 ${formatMoney(percent)}`
  });
}

const costBandDeleteMatch = userMessage
  .trim()
  .match(/^成本異常刪除(?:\s+(\d+(?:\.\d+)?))?$/);
if (costBandDeleteMatch) {
  const percent = Number(costBandDeleteMatch[1] || 30);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：成本異常刪除 30"
    });
  }

  const result = await deleteCostBandAlerts(watchlistKey, percent);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🗑️ 已刪除成本異常提醒

刪除區間：平均成本 ±${formatPercent(percent)}%
套用持股：${result.rows.length} 檔
已處理提醒：約 ${result.deleted} 筆

若要重新建立，輸入：
成本異常設定 ${formatMoney(percent)}`
  });
}

const costBandRebuildMatch = userMessage
  .trim()
  .match(/^成本異常重建(?:\s+(\d+(?:\.\d+)?))?$/);
if (costBandRebuildMatch) {
  const percent = Number(costBandRebuildMatch[1] || 30);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：成本異常重建 30"
    });
  }

  await deleteCostBandAlerts(watchlistKey, percent);
  const rows = await setupCostBandAlerts(watchlistKey, percent);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `♻️ 已重建成本異常提醒

重建區間：平均成本 ±${formatPercent(percent)}%
套用持股：${rows.length} 檔
提醒總數：${rows.length * 2} 筆

可輸入「成本異常查看」確認狀態。`
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
        `${index + 1}. ${stockLabel(alert.code, stockNames[alert.code])}：${
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

        return `${triggered ? "✅ 到價" : "⏳ 未到"} ${stockLabel(alert.code, stockNames[alert.code])}
現價：${price} 元｜條件：${alert.targetPrice} 元 ${alertDirectionLabel(
          alert.direction
        )}${triggered ? "\n此提醒已自動關閉。" : ""}`;
      } catch {
        return `⚠️ ${stockLabel(alert.code, stockNames[alert.code])}：報價查詢失敗`;
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
  const skipped = [];
  const existingTrades = await getAllTrades(watchlistKey);
  const fingerprints = new Set(existingTrades.map(tradeFingerprint));

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

    const trade = {
      code,
      type,
      shares,
      price,
      fee,
      tax,
      realizedProfit,
      tradedAt
    };
    const fingerprint = tradeFingerprint(trade);
    if (fingerprints.has(fingerprint)) {
      skipped.push(line);
      continue;
    }

    await recordTrade(watchlistKey, trade);
    fingerprints.add(fingerprint);

    const typeLabel = type === "buy" ? "買進" : "賣出";
    saved.push(
      `${parts[0]} ${typeLabel} ${stockLabel(code, stockNames[code])} ${formatMoney(
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
  const skippedText =
    skipped.length > 0 ? `\n\n已跳過重複：${skipped.length} 筆` : "";

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `📥 已匯入交易紀錄：${saved.length} 筆

${savedText}
${skippedText}
${failedText}

提醒：這只補交易歷史，不會改目前持股。
輸入「交易匯入狀態」可查看目前總筆數。`
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
    text: `🧮 買進前試算：${stockLabel(code, stockNames[code])}

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
      text: `試算失敗：${stockLabel(code, stockNames[code])} 目前持股不足。`
    });
  }

  const costBasis = Number(current.averageCost) * sellShares;
  const realizedProfit = sellAmount - costBasis - fee - tax;
  const netReceive = sellAmount - fee - tax;
  const remainingShares = Number(current.shares) - sellShares;
  const profitPercent = costBasis > 0 ? (realizedProfit / costBasis) * 100 : 0;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧮 賣出前試算：${stockLabel(code, stockNames[code])}

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
    text: `🧾 已記錄買進：${stockLabel(code, stockNames[code])}
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
      text: `賣出失敗：${stockLabel(code, stockNames[code])} 目前持股不足。`
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
    text: `💸 已記錄賣出：${stockLabel(code, stockNames[code])}
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
第 ${index} 筆：買進 ${stockLabel(trade.code, stockNames[trade.code])}
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
第 ${index} 筆：${typeLabel} ${stockLabel(trade.code, stockNames[trade.code])}
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

      return `${index + 1}. ${typeLabel} ${stockLabel(trade.code, stockNames[trade.code])}
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
      : stockLabel(dividend.code, stockNames[dividend.code]);

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
    text: `🎁 已記錄股息/股利：${stockLabel(code, stockNames[code])}
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
          : stockLabel(dividend.code, stockNames[dividend.code]);
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

if (userMessage.trim() === "盤中快訊" || userMessage.trim() === "持股快訊") {
  const text = await buildIntradayDecisionAnalysis(watchlistKey, stockNames);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      text ||
      "目前沒有持股資料，無法產生盤中分析。請先輸入「匯入持股」或「持股+台積電 35 2000」。"
  });
}

if (userMessage.trim() === "異常設定") {
  const settings = getIntradayAnomalySettings(watchlistKey);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `⚙️ 目前盤中異常門檻

單檔報酬率變動：${formatPercent(settings.stockMovePercent)}%
單檔損益變動：${formatMoney(settings.stockProfitDelta)} 元
總損益變動：${formatMoney(settings.totalProfitDelta)} 元

修改格式：
異常設定 3 3000 8000

代表：
單檔報酬率變動 3%
單檔損益變動 3000 元
總損益變動 8000 元`
  });
}

const anomalySettingMatch = userMessage
  .trim()
  .match(/^異常設定\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
if (anomalySettingMatch) {
  const stockMovePercent = Number(anomalySettingMatch[1]);
  const stockProfitDelta = Number(anomalySettingMatch[2]);
  const totalProfitDelta = Number(anomalySettingMatch[3]);
  if (
    stockMovePercent <= 0 ||
    stockProfitDelta <= 0 ||
    totalProfitDelta <= 0
  ) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。請輸入：異常設定 3 3000 8000"
    });
  }

  saveIntradayAnomalySettings(watchlistKey, {
    stockMovePercent,
    stockProfitDelta,
    totalProfitDelta
  });
  intradayAnomalyBaselines.delete(watchlistKey);
  intradayAnomalyPushLog.delete(watchlistKey);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已更新盤中異常門檻

單檔報酬率變動：${formatPercent(stockMovePercent)}%
單檔損益變動：${formatMoney(stockProfitDelta)} 元
總損益變動：${formatMoney(totalProfitDelta)} 元

提醒：已清除舊基準。請再輸入「盤中異常」建立新基準。`
  });
}

if (userMessage.trim() === "異常設定重設") {
  intradayAnomalySettings.delete(watchlistKey);
  intradayAnomalyBaselines.delete(watchlistKey);
  intradayAnomalyPushLog.delete(watchlistKey);
  const settings = getIntradayAnomalySettings(watchlistKey);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已重設盤中異常門檻

單檔報酬率變動：${formatPercent(settings.stockMovePercent)}%
單檔損益變動：${formatMoney(settings.stockProfitDelta)} 元
總損益變動：${formatMoney(settings.totalProfitDelta)} 元

請再輸入「盤中異常」建立新基準。`
  });
}

if (userMessage.trim() === "盤中異常" || userMessage.trim() === "異常快訊") {
  const result = await evaluateIntradayAnomalies(watchlistKey);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: result.text
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

  const evaluatedHoldings = analysisItems(totals.successful);
  const strongest = [...evaluatedHoldings]
    .sort((a, b) => b.profitPercent - a.profitPercent)
    .slice(0, 3);
  const weakest = [...evaluatedHoldings]
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 3);

  const formatDailyRank = (items) =>
    items.length > 0
      ? items
          .map(
            (item, index) =>
              `${index + 1}. ${stockLabel(item.code, item.name)}：${profitSign(
                item.profitPercent
              )}${formatPercent(item.profitPercent)}%，損益 ${profitSign(
                item.profit
              )}${formatMoney(item.profit)} 元`
          )
          .join("\n")
      : "暫無可計算資料";

  const aiInput = [...evaluatedHoldings]
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit))
    .slice(0, 8)
    .map(
      (item) =>
        `${stockLabel(item.code, item.name)} 報酬${profitSign(item.profitPercent)}${formatPercent(
          item.profitPercent
        )}% 損益${profitSign(item.profit)}${formatMoney(item.profit)} 市值${formatMoney(
          item.marketValue
        )}`
    )
    .join("\n");

  let aiSummary = "今日資料已整理完成，請搭配市場風險自行評估。";
  try {
    const completion = await getOpenAIClient().chat.completions.create({
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
        `${index + 1}. ${stockLabel(item.code, item.name)}：${formatPercent(
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

  const evaluatedHoldings = analysisItems(totals.successful);
  const withWeight = evaluatedHoldings
    .map((item) => ({
      ...item,
      weight: (item.marketValue / totals.totalMarket) * 100
    }))
    .sort((a, b) => b.weight - a.weight);
  const topWeights = withWeight
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, item.name)}：${formatPercent(item.weight)}%`
    )
    .join("\n");
  const overweight = withWeight
    .filter((item) => item.weight >= 20)
    .map((item) => `${stockLabel(item.code, item.name)}${formatPercent(item.weight)}%`);
  const watchWeight = withWeight
    .filter((item) => item.weight >= 15 && item.weight < 20)
    .map((item) => `${stockLabel(item.code, item.name)}${formatPercent(item.weight)}%`);
  const deepLosses = evaluatedHoldings
    .filter((item) => item.profitPercent <= -30)
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .map(
      (item) =>
        `${stockLabel(item.code, item.name)}：${profitSign(item.profitPercent)}${formatPercent(
          item.profitPercent
        )}%`
    );
  const mildLosses = evaluatedHoldings
    .filter((item) => item.profitPercent <= -10 && item.profitPercent > -30)
    .sort((a, b) => a.profitPercent - b.profitPercent)
    .slice(0, 5)
    .map(
      (item) =>
        `${stockLabel(item.code, item.name)}：${profitSign(item.profitPercent)}${formatPercent(
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
      text: `目前沒有 ${stockLabel(code, stockNames[code])} 這檔持股。`
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
        `${index + 1}. ${stockLabel(item.code, item.name)}：${formatPercent(item.weight)}%`
    )
    .join("\n");

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🧮 再平衡減碼試算

標的：${stockLabel(target.code, target.name)}
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

  const withWeight = analysisItems(totals.successful)
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
        `${index + 1}. ${stockLabel(item.code, item.name)}：${formatPercent(item.weight)}%`
    )
    .join("\n");
  const overweightText =
    overweight.length > 0
      ? overweight
          .map(
            (item, index) =>
              `${index + 1}. ${stockLabel(item.code, item.name)}：${formatPercent(
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
              `${index + 1}. ${stockLabel(item.code, item.name)}：目前 ${formatPercent(
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
              `${index + 1}. ${stockLabel(item.code, item.name)}：${profitSign(
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
  const evaluatedHoldings = analysisItems(totals.successful);
  const winners = [...evaluatedHoldings]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, item.name)}：${profitSign(item.profit)}${formatMoney(
          item.profit
        )} 元（${profitSign(item.profitPercent)}${formatPercent(item.profitPercent)}%）`
    )
    .join("\n");
  const losers = [...evaluatedHoldings]
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${stockLabel(item.code, item.name)}：${profitSign(item.profit)}${formatMoney(
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
      text: `目前沒有 ${stockLabel(code, stockNames[code])} 的持股資料。`
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
  const holdingLines = analysisItems(totals.successful)
    .map(
      (item) =>
        `${stockLabel(item.code, item.name)} 持有${item.shares}股 成本${item.averageCost} 現價${item.price} 市值${formatMoney(
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

  const completion = await getOpenAIClient().chat.completions.create({
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
        ? `⭐ 已加入自選：${stockLabel(code, stockNames[code])}`
        : `🗑️ 已移除自選：${stockLabel(code, stockNames[code])}`
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
        return `${stockLabel(code, stockNames[code])}：${price} 元，${percent}%`;
      } catch {
        return `${stockLabel(code, stockNames[code])}：查詢失敗`;
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

      const completion = await getOpenAIClient().chat.completions.create({
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

      const completion = await getOpenAIClient().chat.completions.create({
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
    const completion = await getOpenAIClient().chat.completions.create({
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
app.use(express.json({ limit: "2mb" }));

const requireWebSyncToken = (req, res, next) => {
  const token = process.env.WEB_SYNC_TOKEN;
  if (!token) {
    return next();
  }
  const provided =
    req.headers["x-sync-token"] || req.query.token || req.body?.syncToken;
  if (provided !== token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
};

const requireConfiguredWebSyncToken = (req, res, next) => {
  if (!process.env.WEB_SYNC_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "WEB_SYNC_TOKEN is not configured"
    });
  }
  return requireWebSyncToken(req, res, next);
};

const getWebSyncOwnerKey = async () => {
  const configured =
    process.env.WEB_SYNC_OWNER_KEY ||
    process.env.LINE_USER_ID ||
    process.env.LINE_OWNER_KEY;
  if (configured) {
    return configured;
  }

  const ownerKeys = await getPortfolioOwnerKeys();
  if (ownerKeys.length === 1) {
    return ownerKeys[0];
  }
  if (ownerKeys.length === 0) {
    throw new Error("找不到 LINE 使用者資料。請先在 LINE 輸入「我的持股」或「持股+台積電 1 100」。");
  }
  throw new Error("Supabase 有多個 LINE 使用者，請在 Railway 設定 WEB_SYNC_OWNER_KEY。");
};

const parseWebTradeDate = (date) => {
  const parsed = parseHistoricalTradeDate(date);
  return parsed || new Date().toISOString();
};

const normalizeWebCode = (value) => String(value || "").trim();
const DEFAULT_EXCLUDED_WEB_SYMBOLS = { "4132": "國鼎下市" };
const normalizeExcludedWebSymbols = (value = {}) => {
  const excluded = { ...DEFAULT_EXCLUDED_WEB_SYMBOLS };
  if (Array.isArray(value)) {
    value.forEach((symbol) => {
      const code = normalizeWebCode(symbol);
      if (code) excluded[code] = excluded[code] || "排除目前資產";
    });
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([symbol, reason]) => {
      const code = normalizeWebCode(symbol);
      if (code) excluded[code] = String(reason || excluded[code] || "排除目前資產");
    });
  }
  return excluded;
};

const normalizeWebTrades = (trades = []) =>
  [...trades]
    .filter((trade) => trade && trade.symbol && trade.type)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .map((trade) => ({
      code: normalizeWebCode(trade.symbol),
      name: trade.name || dailyName(normalizeWebCode(trade.symbol)),
      type: trade.type === "sell" ? "sell" : "buy",
      shares: Number(trade.shares || 0),
      price: Number(trade.price || 0),
      fee: Number(trade.fee || 0),
      tax: Number(trade.tax || 0),
      tradedAt: parseWebTradeDate(trade.date)
    }))
    .filter(
      (trade) =>
        /^\d{4,6}[A-Z]?$/.test(trade.code) &&
        trade.shares > 0 &&
        trade.price > 0
    );

const buildPortfolioFromWebState = (webState = {}) => {
  const portfolio = new Map();
  const running = new Map();
  const excludedSymbols = normalizeExcludedWebSymbols(webState.excludedSymbols);
  const isExcluded = (code) => !!excludedSymbols[normalizeWebCode(code)];
  const normalizedTrades = normalizeWebTrades(webState.trades || []);
  const tradesWithProfit = [];

  for (const trade of normalizedTrades) {
    const current = running.get(trade.code) || {
      shares: 0,
      totalCost: 0
    };

    if (trade.type === "buy") {
      current.shares += trade.shares;
      current.totalCost += trade.shares * trade.price + trade.fee;
      tradesWithProfit.push({ ...trade, realizedProfit: 0 });
    } else {
      const sellShares = Math.min(trade.shares, current.shares);
      const averageCost =
        current.shares > 0 ? current.totalCost / current.shares : 0;
      const realizedProfit =
        sellShares * trade.price - trade.fee - trade.tax - averageCost * sellShares;
      current.shares -= sellShares;
      current.totalCost -= averageCost * sellShares;
      if (current.shares <= 0.000001) {
        current.shares = 0;
        current.totalCost = 0;
      }
      tradesWithProfit.push({ ...trade, realizedProfit });
    }

    running.set(trade.code, current);
  }

  for (const dividend of webState.dividends || []) {
    const code = normalizeWebCode(dividend.symbol);
    const current = running.get(code);
    if (!current) {
      continue;
    }
    const stockShares =
      (Number(dividend.shares || 0) * Number(dividend.stock || 0)) / 10;
    if (stockShares > 0) {
      current.shares += stockShares;
      running.set(code, current);
    }
  }

  for (const [code, position] of running.entries()) {
    if (position.shares > 0 && !isExcluded(code)) {
      portfolio.set(code, {
        shares: Number(position.shares.toFixed(4)),
        averageCost: Number((position.totalCost / position.shares).toFixed(2))
      });
    }
  }

  return { portfolio, trades: tradesWithProfit };
};

const replaceTradesFromWeb = async (ownerKey, trades) => {
  if (!hasPortfolioDb) {
    portfolioTrades.set(
      ownerKey,
      trades.map((trade) => ({ ...trade }))
    );
    return;
  }

  await axios.delete(tradeApiUrl(), {
    headers: supabaseHeaders(),
    params: { owner_key: `eq.${ownerKey}` }
  });

  const rows = trades.map((trade) => ({
    owner_key: ownerKey,
    code: trade.code,
    trade_type: trade.type,
    shares: trade.shares,
    price: trade.price,
    fee: trade.fee || 0,
    tax: trade.tax || 0,
    realized_profit: Number(trade.realizedProfit || 0),
    traded_at: trade.tradedAt
  }));

  if (rows.length > 0) {
    await axios.post(tradeApiUrl(), rows, {
      headers: supabaseHeaders()
    });
  }
};

const WEB_DIVIDEND_NOTE_PREFIX = "WEB_DIVIDEND:";

const normalizeWebDividendDetail = (dividend = {}) => {
  const code = normalizeWebCode(dividend.symbol || dividend.code);
  const shares = Number(dividend.shares || 0);
  const cash = Number(dividend.cash || 0);
  const stock = Number(dividend.stock || 0);
  const fee = Number(dividend.fee || 0);
  const nhi = Number(dividend.nhi || 0);
  const grossCash = shares * cash;
  const amount = grossCash - fee - nhi;

  return {
    date: String(dividend.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    symbol: code,
    name: dividend.name || dailyName(code),
    year: dividend.year || new Date().getFullYear(),
    shares,
    cash,
    stock,
    fee,
    nhi,
    grossCash: Number(grossCash.toFixed(2)),
    amount: Number(amount.toFixed(2))
  };
};

const normalizeWebDividends = (dividends = []) => {
  const receivedAtCounts = new Map();
  return dividends
    .filter((dividend) => dividend && (dividend.symbol || dividend.code))
    .map((dividend) => {
      const detail = normalizeWebDividendDetail(dividend);
      const noteText = [
        detail.year ? `${detail.year} 年度` : "",
        detail.name || dailyName(detail.symbol),
        `${detail.shares} 股`,
        detail.cash ? `每股現金 ${detail.cash}` : "",
        detail.stock ? `股票股利 ${detail.stock} 股/10股` : "",
        detail.fee ? `手續費 ${detail.fee}` : "",
        detail.nhi ? `補充費 ${detail.nhi}` : ""
      ]
        .filter(Boolean)
        .join(" ");

      const receivedAtBase = parseWebTradeDate(detail.date);
      const receivedAtKey = `${detail.symbol}|${String(receivedAtBase).slice(0, 10)}`;
      const receivedAtOffset = receivedAtCounts.get(receivedAtKey) || 0;
      receivedAtCounts.set(receivedAtKey, receivedAtOffset + 1);
      const receivedAtDate = new Date(receivedAtBase);
      receivedAtDate.setSeconds(receivedAtDate.getSeconds() + receivedAtOffset);

      return {
        code: detail.symbol,
        // Supabase requires amount > 0. Stock-only dividends keep their real
        // zero-cash detail in the encoded note and use a tiny storage sentinel.
        amount:
          detail.amount > 0 ? Number(detail.amount.toFixed(0)) : 0.01,
        receivedAt: receivedAtDate.toISOString(),
        note: `${WEB_DIVIDEND_NOTE_PREFIX}${JSON.stringify(detail)} ${noteText}`
      };
    })
    .filter(
      (dividend) =>
        /^\d{4,6}[A-Z]?$/.test(dividend.code) &&
        (dividend.amount !== 0 || dividend.note.includes('"stock":'))
    );
};

const formatTaipeiDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(safeDate);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

const replaceDividendsFromWeb = async (ownerKey, dividends) => {
  if (!hasPortfolioDb) {
    portfolioDividends.set(
      ownerKey,
      dividends.map((dividend) => ({
        ...dividend,
        receivedAt: new Date().toISOString()
      }))
    );
    return;
  }

  await axios.delete(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: { owner_key: `eq.${ownerKey}` }
  });

  const rows = dividends.map((dividend) => ({
    owner_key: ownerKey,
    code: dividend.code,
    amount: dividend.amount,
    note: dividend.note || "",
    received_at: dividend.receivedAt || new Date().toISOString()
  }));

  if (rows.length > 0) {
    await axios.post(dividendApiUrl(), rows, {
      headers: supabaseHeaders()
    });
  }
};

const getAllDividendsForWeb = async (ownerKey) => {
  if (!hasPortfolioDb) {
    return portfolioDividends.get(ownerKey) || [];
  }

  const response = await axios.get(dividendApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${ownerKey}`,
      select: "id,code,amount,note,received_at",
      order: "received_at.desc",
      limit: 1000
    }
  });

  return response.data || [];
};

const buildWebStateFromLine = async (ownerKey) => {
  const portfolio = await getPortfolio(ownerKey);
  const trades = await getAllTrades(ownerKey);
  const dividends = await getAllDividendsForWeb(ownerKey);

  const webTrades =
    trades.length > 0
      ? trades.map((trade) => ({
          id: `line_${trade.id || `${trade.code}_${trade.tradedAt}`}`,
          date: formatTaipeiDateKey(trade.tradedAt || new Date()),
          type: trade.type,
          symbol: trade.code,
          name: dailyName(trade.code),
          shares: Number(trade.shares || 0),
          price: Number(trade.price || 0),
          fee: Number(trade.fee || 0),
          tax: Number(trade.tax || 0)
        }))
      : [...portfolio.entries()].map(([code, position]) => ({
          id: `line_position_${code}`,
          date: formatTaipeiDateKey(),
          type: "buy",
          symbol: code,
          name: dailyName(code),
          shares: Number(position.shares || 0),
          price: Number(position.averageCost || 0),
          fee: 0,
          tax: 0
        }));

  const webDividends = dividends.map((dividend) => {
    const note = String(dividend.note || "");
    const encodedDetail = note.startsWith(WEB_DIVIDEND_NOTE_PREFIX)
      ? note.slice(WEB_DIVIDEND_NOTE_PREFIX.length).match(/^\{.*?\}(?=\s|$)/)?.[0]
      : null;

    if (encodedDetail) {
      try {
        const detail = JSON.parse(encodedDetail);
        return {
          id: `line_dividend_${dividend.id || `${dividend.code}_${dividend.received_at}`}`,
          date: detail.date || formatTaipeiDateKey(dividend.received_at || new Date()),
          symbol: detail.symbol || dividend.code,
          name: detail.name || dailyName(detail.symbol || dividend.code),
          year: detail.year || new Date(dividend.received_at || Date.now()).getFullYear(),
          shares: Number(detail.shares || 0),
          cash: Number(detail.cash || 0),
          stock: Number(detail.stock || 0),
          fee: Number(detail.fee || 0),
          nhi: Number(detail.nhi || 0)
        };
      } catch {
        // Fall through to legacy conversion below.
      }
    }

    return {
      id: `line_dividend_${dividend.id || `${dividend.code}_${dividend.received_at}`}`,
      date: formatTaipeiDateKey(dividend.received_at || new Date()),
      symbol: dividend.code,
      name: dailyName(dividend.code),
      year:
        note.match(/\d{4}/)?.[0] ||
        new Date(dividend.received_at || Date.now()).getFullYear(),
      shares: 1,
      cash: Number(dividend.amount || 0),
      stock: 0,
      fee: 0,
      nhi: 0
    };
  });

  return {
    trades: webTrades,
    dividends: webDividends,
    prices: {},
    priceUpdated: {},
    snapshots: [],
    customNames: {},
    excludedSymbols: normalizeExcludedWebSymbols({}),
    _updatedAt: Date.now()
  };
};

app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: BOT_BUILD_VERSION,
    portfolioDb: hasPortfolioDb,
    cloudState: hasCloudState,
    finMind: Boolean(FINMIND_TOKEN)
  });
});

const webCloudBackupKey = (ownerKey) => `web-state:${ownerKey}`;

const getSupabaseWebCloudState = async (ownerKey) => {
  if (!hasPortfolioDb) return null;
  const response = await axios.get(backupApiUrl(), {
    headers: supabaseHeaders(),
    params: {
      owner_key: `eq.${webCloudBackupKey(ownerKey)}`,
      select: "portfolio,updated_at",
      limit: 1
    },
    timeout: 8000
  });
  const row = response.data?.[0];
  if (!row?.portfolio || Array.isArray(row.portfolio)) return null;
  return row.portfolio;
};

const saveSupabaseWebCloudState = async (ownerKey, state) => {
  if (!hasPortfolioDb) return false;
  await axios.post(
    `${backupApiUrl()}?on_conflict=owner_key`,
    {
      owner_key: webCloudBackupKey(ownerKey),
      portfolio: state,
      updated_at: new Date().toISOString()
    },
    {
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      timeout: 8000
    }
  );
  return true;
};

const normalizedWebRecordId = (record = {}) => {
  const id = String(record.id || "");
  if (id.startsWith("cloud_line_")) return id.slice("cloud_".length);
  if (id.startsWith("line_")) return id;
  if (id.startsWith("cloud_line_dividend_")) return id.slice("cloud_".length);
  if (id.startsWith("line_dividend_")) return id;
  return "";
};

const webRecordContentKey = (record = {}) => [
  String(record.date || ""),
  String(record.type || ""),
  String(record.symbol || record.code || ""),
  Number(record.shares || 0),
  Number(record.price || 0),
  Number(record.fee || 0),
  Number(record.tax || 0),
  Number(record.cash || 0),
  Number(record.stock || 0),
  Number(record.nhi || 0)
].join("|");

const webRecordKey = (record = {}) =>
  normalizedWebRecordId(record) || webRecordContentKey(record);

const mergeWebRecords = (incomingRecords = [], existingRecords = []) => {
  const combinedRecords = [...existingRecords, ...incomingRecords];
  const contentKeysCoveredByLineIds = new Set(
    combinedRecords
      .filter((record) => normalizedWebRecordId(record))
      .map((record) => webRecordContentKey(record))
  );
  const records = new Map();
  combinedRecords.forEach((record) => {
    const normalizedId = normalizedWebRecordId(record);
    const contentKey = webRecordContentKey(record);
    if (!normalizedId && contentKeysCoveredByLineIds.has(contentKey)) return;
    const key = normalizedId || contentKey;
    if (!key || key === "||||0|0|0|0|0|0") return;
    records.set(key, record);
  });
  return [...records.values()].sort((a, b) => {
    const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
};

const normalizeWebSnapshot = (snapshot = {}) => {
  const date = String(snapshot.date || "").trim();
  if (!date) return null;
  return {
    date,
    mv: Number(snapshot.mv || 0),
    cost: Number(snapshot.cost || 0),
    realized: Number(snapshot.realized || 0),
    dividend: Number(snapshot.dividend || 0)
  };
};

const mergeWebSnapshots = (incomingSnapshots = [], existingSnapshots = []) => {
  const byDate = new Map();
  [...existingSnapshots, ...incomingSnapshots].forEach((snapshot) => {
    const normalized = normalizeWebSnapshot(snapshot);
    if (!normalized) return;
    const hasUsefulNumbers =
      normalized.mv > 0 ||
      normalized.cost > 0 ||
      normalized.realized !== 0 ||
      normalized.dividend !== 0;
    if (!byDate.has(normalized.date) || hasUsefulNumbers) {
      byDate.set(normalized.date, normalized);
    }
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
};

const mergeWebCloudState = (incomingState = {}, existingState = {}) => ({
  ...existingState,
  ...incomingState,
  trades: mergeWebRecords(incomingState.trades || [], existingState.trades || []),
  dividends: mergeWebRecords(incomingState.dividends || [], existingState.dividends || []),
  snapshots: mergeWebSnapshots(incomingState.snapshots || [], existingState.snapshots || []),
  prices: { ...(existingState.prices || {}), ...(incomingState.prices || {}) },
  priceUpdated: { ...(existingState.priceUpdated || {}), ...(incomingState.priceUpdated || {}) },
  customNames: { ...(existingState.customNames || {}), ...(incomingState.customNames || {}) },
  excludedSymbols: normalizeExcludedWebSymbols({
    ...(existingState.excludedSymbols || {}),
    ...(incomingState.excludedSymbols || {})
  }),
  cfg: { ...(existingState.cfg || {}), ...(incomingState.cfg || {}) },
  _updatedAt: Date.now()
});

const webRecordSetSignature = (records = []) =>
  [...records]
    .map((record) => webRecordContentKey(record))
    .filter(Boolean)
    .sort()
    .join("\n");

const webPortfolioRecordsChanged = (nextState = {}, previousState = {}) =>
  webRecordSetSignature(nextState.trades || []) !==
    webRecordSetSignature(previousState.trades || []) ||
  webRecordSetSignature(nextState.dividends || []) !==
    webRecordSetSignature(previousState.dividends || []);

const syncWebStateToPortfolioDb = async (ownerKey, webState = {}) => {
  const { portfolio, trades } = buildPortfolioFromWebState(webState);
  const dividends = normalizeWebDividends(webState.dividends || []);
  await replacePortfolio(ownerKey, portfolio);
  await replaceTradesFromWeb(ownerKey, trades);
  await replaceDividendsFromWeb(ownerKey, dividends);
  return {
    holdings: portfolio.size,
    trades: trades.length,
    dividends: dividends.length
  };
};

const cloudLineId = (id) => {
  const value = String(id || "");
  return value.startsWith("line_") ? `cloud_${value}` : value;
};

const buildCanonicalCloudStateFromLine = async (ownerKey, existingState = {}) => {
  const lineState = await buildWebStateFromLine(ownerKey);
  return {
    ...existingState,
    ...lineState,
    trades: (lineState.trades || []).map((trade) => ({
      ...trade,
      id: cloudLineId(trade.id)
    })),
    dividends: (lineState.dividends || []).map((dividend) => ({
      ...dividend,
      id: cloudLineId(dividend.id)
    })),
    snapshots: existingState.snapshots || [],
    prices: existingState.prices || {},
    priceUpdated: existingState.priceUpdated || {},
    cfg: existingState.cfg || {},
    customNames: {
      ...(existingState.customNames || {}),
      ...(lineState.customNames || {})
    },
    excludedSymbols: normalizeExcludedWebSymbols({
      ...(existingState.excludedSymbols || {}),
      ...(lineState.excludedSymbols || {})
    }),
    _updatedAt: Date.now()
  };
};

const countWebState = (state = {}) => ({
  trades: Array.isArray(state.trades) ? state.trades.length : 0,
  dividends: Array.isArray(state.dividends) ? state.dividends.length : 0,
  snapshots: Array.isArray(state.snapshots) ? state.snapshots.length : 0
});

const cloudCountsNeedRepair = (lineCounts = {}, cloudCounts = {}) =>
  Number(lineCounts.trades || 0) > 0 &&
  (Number(lineCounts.trades || 0) !== Number(cloudCounts.trades || 0) ||
    Number(lineCounts.dividends || 0) !== Number(cloudCounts.dividends || 0));

const repairWebCloudStateFromLine = async (ownerKey, reason = "manual") => {
  const existingState = await getSupabaseWebCloudState(ownerKey).catch(() => null);
  const repairedState = await buildCanonicalCloudStateFromLine(ownerKey, existingState || {});
  await saveSupabaseWebCloudState(ownerKey, repairedState);

  if (hasCloudState) {
    axios.put(jsonBinUrl(), repairedState, {
      headers: jsonBinHeaders({ "Content-Type": "application/json" }),
      timeout: 8000
    }).catch((error) => {
      console.warn(`JSONBin repair backup failed: ${serviceErrorMessage(error)}`);
    });
  }

  return {
    ok: true,
    reason,
    counts: countWebState(repairedState),
    updatedAt: repairedState._updatedAt
  };
};

const checkAndRepairWebCloudState = async () => {
  if (!hasPortfolioDb) return { ok: false, skipped: "portfolioDb disabled" };
  const ownerKey = await getWebSyncOwnerKey();
  const portfolio = await getPortfolio(ownerKey);
  const trades = await getAllTrades(ownerKey);
  const dividends = await getAllDividendsForWeb(ownerKey);
  const lineCounts = {
    holdings: portfolio.size,
    trades: trades.length,
    dividends: dividends.length
  };
  const cloudState = await getSupabaseWebCloudState(ownerKey).catch(() => null);
  const cloudCounts = countWebState(cloudState || {});

  if (!cloudState || cloudCountsNeedRepair(lineCounts, cloudCounts)) {
    const repaired = await repairWebCloudStateFromLine(
      ownerKey,
      !cloudState ? "missing-cloud-state" : "line-cloud-count-mismatch"
    );
    return {
      ok: true,
      repaired: true,
      lineCounts,
      before: cloudCounts,
      after: repaired.counts
    };
  }

  return {
    ok: true,
    repaired: false,
    lineCounts,
    cloudCounts
  };
};

const okCheck = (ok, detail = {}) => ({ ok: Boolean(ok), ...detail });

const buildSystemDiagnostics = async () => {
  const checkedAt = new Date().toISOString();
  const diagnostics = {
    ok: true,
    checkedAt,
    version: BOT_BUILD_VERSION,
    env: {
      line: Boolean(config.channelAccessToken && config.channelSecret),
      openai: Boolean(process.env.OPENAI_API_KEY),
      portfolioDb: hasPortfolioDb,
      cloudState: hasCloudState,
      finMind: Boolean(FINMIND_TOKEN),
      webSyncOwnerKey: Boolean(process.env.WEB_SYNC_OWNER_KEY || process.env.LINE_USER_ID || process.env.LINE_OWNER_KEY),
      publicBaseUrl: Boolean(process.env.PUBLIC_BASE_URL)
    },
    schedules: {
      priceAlertsMs: ALERT_CHECK_INTERVAL_MS,
      lineStockPushEnabled: LINE_STOCK_PUSH_ENABLED,
      intradayAnalysisEnabled:
        LINE_STOCK_PUSH_ENABLED && INTRADAY_ANALYSIS_ENABLED,
      intradayAnalysisTimes: INTRADAY_ANALYSIS_TIMES,
      intradayAnomalyEnabled:
        INTRADAY_ANOMALY_ENABLED && typeof checkAndPushIntradayAnomalies === "function",
      dailyReportEnabled: LINE_STOCK_PUSH_ENABLED && DAILY_REPORT_ENABLED,
      dailyReportTimes: DAILY_REPORT_TIMES,
      dailyChipMovementEnabled:
        LINE_STOCK_PUSH_ENABLED && DAILY_CHIP_MOVEMENT_ENABLED,
      dailyChipMovementTimes: DAILY_CHIP_MOVEMENT_TIMES,
      scheduledPushCooldownMinutes: Math.round(LINE_SCHEDULED_PUSH_MIN_GAP_MS / 60000),
      alertPushCooldownMinutes: Math.round(LINE_ALERT_PUSH_MIN_GAP_MS / 60000)
    },
    functions: {
      priceAlerts: typeof checkAndPushPriceAlerts === "function",
      tieredCostAlerts: typeof checkAndPushTieredCostAlerts === "function",
      intradayDecisionAnalysis: typeof checkAndPushIntradayDecisionAnalysis === "function",
      intradayAnomalies: typeof checkAndPushIntradayAnomalies === "function",
      dailyReports: typeof checkAndPushDailyReports === "function",
      majorHolderWeekly: typeof buildMajorHolderWeeklyReport === "function",
      dailyChipMovement: typeof buildDailyChipMovementReport === "function"
    },
    checks: {},
    warnings: []
  };

  if (INTRADAY_ANOMALY_ENABLED && typeof checkAndPushIntradayAnomalies !== "function") {
    diagnostics.warnings.push("盤中異常提醒函式未包含在目前版本，已自動略過該排程。");
  }

  try {
    const ownerKeys = await getPortfolioOwnerKeys();
    diagnostics.ownerKeys = ownerKeys.length;
    diagnostics.checks.ownerKeys = okCheck(ownerKeys.length > 0, {
      count: ownerKeys.length
    });

    if (ownerKeys.length > 0) {
      const ownerKey = await getWebSyncOwnerKey();
      const portfolio = await getPortfolio(ownerKey);
      const trades = await getAllTrades(ownerKey);
      const dividends = await getAllDividendsForWeb(ownerKey);
      const cloudState = await getSupabaseWebCloudState(ownerKey).catch(() => null);

      diagnostics.ownerKeyMasked = `${ownerKey.slice(0, 6)}...${ownerKey.slice(-4)}`;
      diagnostics.lineData = {
        holdings: portfolio.size,
        trades: trades.length,
        dividends: dividends.length
      };
      diagnostics.cloudData = countWebState(cloudState || {});
      diagnostics.checks.lineData = okCheck(portfolio.size > 0, diagnostics.lineData);
      diagnostics.checks.cloudData = okCheck(Boolean(cloudState), diagnostics.cloudData);
      if (cloudState) {
        const cloudTradeInflated =
          diagnostics.lineData.trades > 0 &&
          diagnostics.cloudData.trades > diagnostics.lineData.trades * 1.2;
        const cloudDividendInflated =
          diagnostics.lineData.dividends > 0 &&
          diagnostics.cloudData.dividends > diagnostics.lineData.dividends * 1.2;
        if (cloudTradeInflated || cloudDividendInflated) {
          diagnostics.ok = false;
          diagnostics.checks.cloudData = okCheck(false, {
            ...diagnostics.cloudData,
            lineTrades: diagnostics.lineData.trades,
            lineDividends: diagnostics.lineData.dividends,
            error: "Cloud data appears duplicated. Run LINE-to-cloud resync."
          });
          diagnostics.warnings.push("Cloud data appears duplicated. Run LINE-to-cloud resync.");
        }
        if (diagnostics.lineData.trades !== diagnostics.cloudData.trades) {
          diagnostics.warnings.push("LINE 與雲端交易筆數不同，建議重新同步。");
        }
        if (diagnostics.lineData.dividends !== diagnostics.cloudData.dividends) {
          diagnostics.warnings.push("LINE 與雲端股利筆數不同，建議重新同步。");
        }
      }
    }
  } catch (error) {
    diagnostics.ok = false;
    diagnostics.checks.database = okCheck(false, {
      error: serviceErrorMessage(error)
    });
  }

  try {
    const quote = await fetchAlertYahooQuote("2330", 5000);
    diagnostics.checks.quote = okCheck(Number.isFinite(Number(quote.regularMarketPrice)), {
      symbol: "2330",
      price: Number(quote.regularMarketPrice || 0)
    });
  } catch (error) {
    diagnostics.ok = false;
    diagnostics.checks.quote = okCheck(false, {
      symbol: "2330",
      error: serviceErrorMessage(error)
    });
  }

  const requiredFunctionOk =
    diagnostics.functions.priceAlerts &&
    diagnostics.functions.tieredCostAlerts &&
    diagnostics.functions.intradayDecisionAnalysis &&
    diagnostics.functions.dailyReports &&
    diagnostics.functions.majorHolderWeekly;
  const requiredEnvOk = diagnostics.env.line && diagnostics.env.portfolioDb && diagnostics.env.finMind;
  diagnostics.ok = diagnostics.ok && requiredFunctionOk && requiredEnvOk;
  diagnostics.checks.requiredFunctions = okCheck(requiredFunctionOk);
  diagnostics.checks.requiredEnv = okCheck(requiredEnvOk);
  return diagnostics;
};

const buildSystemDiagnosticsText = (diagnostics) => {
  const checkMark = (ok) => (ok ? "✅" : "⚠️");
  const lineData = diagnostics.lineData || {};
  const cloudData = diagnostics.cloudData || {};
  const quote = diagnostics.checks.quote || {};
  const requiredEnvKeys = ["line", "portfolioDb", "finMind"];
  const optionalEnvKeys = ["openai", "cloudState", "webSyncOwnerKey", "publicBaseUrl"];
  const missingEnv = requiredEnvKeys
    .filter((key) => !diagnostics.env?.[key]);
  const missingOptionalEnv = optionalEnvKeys
    .filter((key) => !diagnostics.env?.[key]);
  const missingFunctions = Object.entries(diagnostics.functions || {})
    .filter(([key, value]) => key !== "intradayAnomalies" && !value)
    .map(([key]) => key);
  const warningLines = [
    ...(diagnostics.warnings || []),
    ...missingOptionalEnv.map((key) => `選用環境未設定：${key}`)
  ];
  const missingOptionalFunctions = Object.entries(diagnostics.functions || {})
    .filter(([key, value]) => key === "intradayAnomalies" && !value)
    .map(([key]) => key);
  warningLines.push(...missingOptionalFunctions.map((key) => `選用函式未啟用：${key}`));

  return toLineSafeText(`🩺 系統健檢
狀態：${checkMark(diagnostics.ok)} ${diagnostics.ok ? "正常" : "需要檢查"}
版本：${diagnostics.version}
時間：${diagnostics.checkedAt}

資料
LINE：持股 ${lineData.holdings ?? 0}｜交易 ${lineData.trades ?? 0}｜股利 ${lineData.dividends ?? 0}
雲端：交易 ${cloudData.trades ?? 0}｜股利 ${cloudData.dividends ?? 0}｜快照 ${cloudData.snapshots ?? 0}
報價：${quote.ok ? `2330 ${quote.price}` : `失敗 ${quote.error || ""}`}

排程
盤中分析：${diagnostics.schedules.intradayAnalysisEnabled ? diagnostics.schedules.intradayAnalysisTimes.join(", ") : "停用"}
每日報告：${diagnostics.schedules.dailyReportEnabled ? diagnostics.schedules.dailyReportTimes.join(", ") : "停用"}
盤中異常：${diagnostics.schedules.intradayAnomalyEnabled ? "啟用" : "停用"}

環境缺少：${missingEnv.length ? missingEnv.join(", ") : "無"}
函式缺少：${missingFunctions.length ? missingFunctions.join(", ") : "無"}
提醒：${warningLines.length ? warningLines.join("；") : "無"}`);
};

app.get('/api/system-diagnostics', async (req, res) => {
  try {
    const diagnostics = await buildSystemDiagnostics();
    res.status(diagnostics.ok ? 200 : 503).json(diagnostics);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: serviceErrorMessage(error)
    });
  }
});

app.get('/api/cloud-state', requireWebSyncToken, async (req, res) => {
  let supabaseError;
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const state = await getSupabaseWebCloudState(ownerKey);
    if (state) return res.json(state);
  } catch (error) {
    supabaseError = error;
  }

  if (!hasCloudState) {
    return res.status(503).json({
      ok: false,
      error: `雲端備份尚未可用：${serviceErrorMessage(supabaseError)}`
    });
  }

  try {
    const response = await axios.get(jsonBinUrl('/latest'), {
      headers: jsonBinHeaders(),
      timeout: 12000
    });
    return res.json(response.data?.record || response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    return res.status(status).json({ ok: false, error: `讀取雲端資料失敗：${error.message}` });
  }
});

app.put('/api/cloud-state', requireWebSyncToken, async (req, res) => {
  let state = req.body || {};
  const forceReplace = req.query.force === "1" || req.body?._forceReplace === true;
  let supabaseError;
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const existingState = await getSupabaseWebCloudState(ownerKey).catch(() => null);
    if (!forceReplace) {
      if (existingState) {
        state = mergeWebCloudState(state, existingState);
      }
    }
    const portfolioChanged =
      forceReplace || !existingState || webPortfolioRecordsChanged(state, existingState);
    const syncedCounts = portfolioChanged
      ? await syncWebStateToPortfolioDb(ownerKey, state)
      : null;
    await saveSupabaseWebCloudState(ownerKey, state);

    if (hasCloudState) {
      axios.put(jsonBinUrl(), state, {
        headers: jsonBinHeaders({ "Content-Type": "application/json" }),
        timeout: 8000
      }).catch((error) => {
        console.warn(`JSONBin secondary backup failed: ${serviceErrorMessage(error)}`);
      });
    }

    return res.json({
      ok: true,
      source: "supabase",
      updatedAt: state._updatedAt || Date.now(),
      portfolioSynced: Boolean(syncedCounts),
      counts: syncedCounts || undefined
    });
  } catch (error) {
    supabaseError = error;
  }

  if (!hasCloudState) {
    return res.status(503).json({
      ok: false,
      error: `寫入雲端資料失敗：${serviceErrorMessage(supabaseError)}`
    });
  }

  try {
    if (!forceReplace) {
      const response = await axios.get(jsonBinUrl('/latest'), {
        headers: jsonBinHeaders(),
        timeout: 8000
      }).catch(() => null);
      const existingState = response?.data?.record || response?.data || null;
      if (existingState && typeof existingState === "object") {
        state = mergeWebCloudState(state, existingState);
      }
    }
    await axios.put(jsonBinUrl(), state, {
      headers: jsonBinHeaders({ "Content-Type": "application/json" }),
      timeout: 12000
    });
    return res.json({
      ok: true,
      source: "jsonbin",
      updatedAt: state._updatedAt || Date.now()
    });
  } catch (error) {
    const status = error.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: `寫入雲端資料失敗：Supabase ${serviceErrorMessage(supabaseError)}；JSONBin ${serviceErrorMessage(error)}`
    });
  }
});

app.get('/api/cloud-state/integrity', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const result = await checkAndRepairWebCloudState();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: serviceErrorMessage(error)
    });
  }
});

app.post('/api/butler/message', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const text = String(req.body?.text || req.body?.message || "").trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const result = await buildLineAgentReplies(text, ownerKey);
    const state = await getButlerStateSnapshot(ownerKey);
    res.json({
      ...result,
      state
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: serviceErrorMessage(error)
    });
  }
});

app.get('/api/butler/message', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const text = String(req.query.text || req.query.message || "").trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const result = await buildLineAgentReplies(text, ownerKey);
    const state = await getButlerStateSnapshot(ownerKey);
    res.json({
      ...result,
      state
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: serviceErrorMessage(error)
    });
  }
});

app.post('/api/butler/gemini', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const text = String(req.body?.text || req.body?.message || req.body?.prompt || "").trim();
    const mode = String(req.body?.mode || req.query.mode || "butler").trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const reply =
      mode === "stock-review"
        ? await buildGeminiStockReview(ownerKey, text)
        : await buildGeminiButlerReply(ownerKey, text);
    await saveButlerCloudState(ownerKey);
    res.json({
      ok: true,
      model: GEMINI_MODEL,
      mode,
      text: reply,
      state: await getButlerStateSnapshot(ownerKey)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: serviceErrorMessage(error) });
  }
});

app.get('/api/butler/gemini', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const text = String(req.query.text || req.query.message || req.query.prompt || "").trim();
    const mode = String(req.query.mode || "butler").trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const reply =
      mode === "stock-review"
        ? await buildGeminiStockReview(ownerKey, text)
        : await buildGeminiButlerReply(ownerKey, text);
    await saveButlerCloudState(ownerKey);
    res.json({
      ok: true,
      model: GEMINI_MODEL,
      mode,
      text: reply,
      state: await getButlerStateSnapshot(ownerKey)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: serviceErrorMessage(error) });
  }
});

app.get('/api/butler/memory', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    res.json(await getButlerStateSnapshot(ownerKey));
  } catch (error) {
    res.status(500).json({ ok: false, error: serviceErrorMessage(error) });
  }
});

app.get('/api/butler/reminders', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const state = await getButlerStateSnapshot(ownerKey);
    res.json({
      ok: true,
      reminders: state.reminders,
      pendingReminders: state.pendingReminders
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: serviceErrorMessage(error) });
  }
});

app.get('/api/butler/life-log', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const state = await getButlerStateSnapshot(ownerKey);
    res.json({
      ok: true,
      life: state.life
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: serviceErrorMessage(error) });
  }
});

app.post('/api/cloud-state/repair', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const result = await repairWebCloudStateFromLine(
      ownerKey,
      req.body?.reason || req.query.reason || "manual-api"
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: serviceErrorMessage(error)
    });
  }
});

app.get('/api/web-sync/status', requireWebSyncToken, async (req, res) => {
  try {
    const ownerKey = await getWebSyncOwnerKey();
    const portfolio = await getPortfolio(ownerKey);
    const trades = await getAllTrades(ownerKey);
    const dividends = await getAllDividendsForWeb(ownerKey);
    res.json({
      ok: true,
      portfolioDb: hasPortfolioDb,
      ownerKeyMasked: `${ownerKey.slice(0, 6)}...${ownerKey.slice(-4)}`,
      holdings: portfolio.size,
      trades: trades.length,
      dividends: dividends.length
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/web-sync/push', requireWebSyncToken, async (req, res) => {
  try {
    if (!hasPortfolioDb) {
      return res.status(400).json({
        ok: false,
        error: "Supabase 尚未啟用，無法同步到 LINE。"
      });
    }

    const ownerKey = await getWebSyncOwnerKey();
    const webState = req.body?.state || req.body || {};
    const { portfolio, trades } = buildPortfolioFromWebState(webState);
    const dividends = normalizeWebDividends(webState.dividends || []);

    await replacePortfolio(ownerKey, portfolio);
    await replaceTradesFromWeb(ownerKey, trades);
    await replaceDividendsFromWeb(ownerKey, dividends);

    res.json({
      ok: true,
      ownerKeyMasked: `${ownerKey.slice(0, 6)}...${ownerKey.slice(-4)}`,
      holdings: portfolio.size,
      trades: trades.length,
      dividends: dividends.length
    });
  } catch (error) {
    console.error("Web to LINE sync failed:", error);
    res.status(500).json({
      ok: false,
      error: `同步到 LINE 資料庫失敗：${serviceErrorMessage(error)}`
    });
  }
});

app.get('/api/web-sync/pull', requireWebSyncToken, async (req, res) => {
  try {
    if (!hasPortfolioDb) {
      return res.status(400).json({
        ok: false,
        error: "Supabase 尚未啟用，無法從 LINE 同步。"
      });
    }

    const ownerKey = await getWebSyncOwnerKey();
    const webState = await buildWebStateFromLine(ownerKey);
    res.json({
      ok: true,
      ownerKeyMasked: `${ownerKey.slice(0, 6)}...${ownerKey.slice(-4)}`,
      state: webState,
      trades: webState.trades.length,
      dividends: webState.dividends.length
    });
  } catch (error) {
    console.error("LINE to web sync failed:", error);
    res.status(500).json({
      ok: false,
      error: `從 LINE 資料庫讀取失敗：${serviceErrorMessage(error)}`
    });
  }
});

app.get('/api/ai-dashboard-summary/:symbol', async (req, res) => {
  const symbol = normalizeDashboardSymbol(req.params.symbol);
  if (!symbol) {
    return res.status(400).json({ ok: false, error: "Invalid symbol" });
  }

  const timeframe = String(req.query.timeframe || "D");
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = aiDashboardSummaryCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.cachedAt < AI_DASHBOARD_CACHE_TTL_MS) {
    return res.json({
      ...cached.data,
      cached: true,
      stale: false,
      cachedAt: new Date(cached.cachedAt).toISOString()
    });
  }

  try {
    const response = await axios.get(`${AI_DASHBOARD_BASE_URL}/api/dashboard`, {
      params: {
        symbol,
        timeframe,
        refresh: refresh ? "true" : "false"
      },
      timeout: 12000
    });
    const summary = compactAiDashboardSummary(response.data, symbol);
    const cachedAt = Date.now();
    aiDashboardSummaryCache.set(cacheKey, { data: summary, cachedAt });
    res.json({
      ...summary,
      cached: false,
      stale: false,
      cachedAt: new Date(cachedAt).toISOString()
    });
  } catch (error) {
    if (cached) {
      return res.json({
        ...cached.data,
        cached: true,
        stale: true,
        cachedAt: new Date(cached.cachedAt).toISOString(),
        warning: serviceErrorMessage(error)
      });
    }
    const status = error.response?.status || 502;
    res.status(status).json({
      ok: false,
      symbol,
      error: serviceErrorMessage(error)
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/alerts/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    await checkAndPushPriceAlerts();
    await checkAndPushTieredCostAlerts();
    res.json({ ok: true });
  } catch (error) {
    console.error("手動觸發價格提醒失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/intraday/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const results = await checkAndPushIntradayDecisionAnalysis(true);
    res.json({ ok: true, pushed: results.length, mode: "unified-analysis" });
  } catch (error) {
    console.error("手動觸發整合盤中分析失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/major-holders/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const ownerKeys = await getPortfolioOwnerKeys();
    let pushed = 0;
    for (const ownerKey of ownerKeys) {
      const text = await buildMajorHolderWeeklyReport(ownerKey);
      await client.pushMessage(ownerKey, {
        type: "text",
        text
      });
      pushed += 1;
    }
    res.json({ ok: true, pushed, mode: "major-holder-weekly" });
  } catch (error) {
    console.error("Manual major holder weekly report failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
      detail: error.response?.data || null
    });
  }
});

app.get('/daily-chip/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const results = await checkAndPushDailyChipMovementReports(true);
    res.json({
      ok: true,
      pushed: results.filter((item) => item.pushed).length,
      attempted: results.length,
      mode: "daily-chip-movement"
    });
  } catch (error) {
    console.error("Manual daily chip movement check failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
      detail: error.response?.data || null
    });
  }
});

app.get('/daily-report/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const results = await checkAndPushDailyReports(true);
    res.json({
      ok: true,
      pushed: results.length
    });
  } catch (error) {
    console.error("Manual daily report check failed:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/intraday/analysis/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    const results = await checkAndPushIntradayDecisionAnalysis(true);
    res.json({
      ok: true,
      pushed: results.length
    });
  } catch (error) {
    console.error("Manual intraday decision analysis check failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
      detail: error.response?.data || null
    });
  }
});

app.get('/intraday/anomaly/check', requireConfiguredWebSyncToken, async (req, res) => {
  try {
    if (typeof checkAndPushIntradayAnomalies !== "function") {
      return res.status(503).json({
        ok: false,
        error: "Intraday anomaly alerts are not available in this build"
      });
    }
    const results = await checkAndPushIntradayAnomalies(true);
    res.json({
      ok: true,
      checked: results.length,
      pushed: results.filter((result) => result.shouldPush).length
    });
  } catch (error) {
    console.error("手動觸發盤中異常提醒失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =================【4. 啟動伺服器】=================
const PORT = process.env.PORT || 8080;
const WEB_CLOUD_REPAIR_INTERVAL_MS = Number(process.env.WEB_CLOUD_REPAIR_INTERVAL_MS || 10 * 60 * 1000);
const BUTLER_REMINDER_INTERVAL_MS = Number(process.env.BUTLER_REMINDER_INTERVAL_MS || 30 * 1000);

const checkAndPushButlerReminders = async () => {
  const now = Date.now();
  const pushes = [];
  const ownerKeys = new Set(lineButlerReminders.keys());
  if (hasPortfolioDb) {
    const cloudOwnerKeys = await getPortfolioOwnerKeys().catch(() => []);
    cloudOwnerKeys.forEach((ownerKey) => ownerKeys.add(ownerKey));
  }
  for (const ownerKey of ownerKeys) {
    await hydrateButlerCloudState(ownerKey);
    const rows = lineButlerReminders.get(ownerKey) || [];
    for (const reminder of rows) {
      if (reminder.sent || new Date(reminder.dueAt).getTime() > now) continue;
      reminder.sent = true;
      reminder.sentAt = new Date().toISOString();
      pushes.push(
        client.pushMessage(ownerKey, {
          type: "text",
          text: `管家提醒\n\n時間：${butlerTimeText(reminder.dueAt)}\n內容：${reminder.title}`
        })
      );
    }
    lineButlerReminders.set(
      ownerKey,
      rows.filter((item) => !item.sent || Date.now() - new Date(item.sentAt || item.dueAt).getTime() < 24 * 60 * 60 * 1000)
    );
    await saveButlerCloudState(ownerKey);
  }
  await Promise.all(pushes);
  return pushes.length;
};

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`LINE butler reminders enabled. Interval: ${Math.round(BUTLER_REMINDER_INTERVAL_MS / 1000)} seconds`);
  setInterval(() => {
    checkAndPushButlerReminders().catch((error) => {
      console.error("LINE butler reminder schedule failed:", error);
    });
  }, BUTLER_REMINDER_INTERVAL_MS);
  if (hasPortfolioDb) {
    if (LINE_STOCK_PUSH_ENABLED) {
      console.log(
        `Auto price alerts enabled. Interval: ${Math.round(
          ALERT_CHECK_INTERVAL_MS / 1000
        )} seconds`
      );
      setInterval(() => {
        checkAndPushPriceAlerts().catch((error) => {
          console.error("自動價格提醒排程失敗:", error);
        });
        checkAndPushTieredCostAlerts().catch((error) => {
          console.error("Tiered cost alerts auto check failed:", error);
        });
      }, ALERT_CHECK_INTERVAL_MS);
    } else {
      console.log("All proactive LINE stock notifications disabled");
    }
    console.log("Intraday portfolio briefs merged into decision analysis; standalone brief scheduler disabled");
    if (
      LINE_STOCK_PUSH_ENABLED &&
      INTRADAY_ANALYSIS_ENABLED &&
      INTRADAY_ANALYSIS_TIMES.length > 0
    ) {
      console.log(
        `Intraday decision analysis enabled. Times: ${INTRADAY_ANALYSIS_TIMES.join(
          ", "
        )}`
      );
      setInterval(() => {
        checkAndPushIntradayDecisionAnalysis().catch((error) => {
          console.error("Intraday decision analysis schedule failed:", error);
        });
      }, INTRADAY_PUSH_INTERVAL_MS);
    } else {
      console.log("Intraday decision analysis disabled");
    }
    if (
      LINE_STOCK_PUSH_ENABLED &&
      INTRADAY_ANOMALY_ENABLED &&
      typeof checkAndPushIntradayAnomalies === "function"
    ) {
      console.log(
        `Intraday anomaly alerts enabled. Interval: ${Math.round(
          INTRADAY_ANOMALY_INTERVAL_MS / 1000
        )} seconds`
      );
      setInterval(() => {
        checkAndPushIntradayAnomalies().catch((error) => {
          console.error("盤中異常提醒排程失敗:", error);
        });
      }, INTRADAY_ANOMALY_INTERVAL_MS);
    } else {
      console.log("Intraday anomaly alerts disabled");
    }
    if (LINE_STOCK_PUSH_ENABLED && DAILY_REPORT_ENABLED) {
      console.log(
        `Daily portfolio report scheduler enabled. Default times: ${DAILY_REPORT_TIMES.join(
          ", "
        ) || "none"}`
      );
      setInterval(() => {
        checkAndPushDailyReports().catch((error) => {
          console.error("Daily portfolio report schedule failed:", error);
        });
      }, DAILY_REPORT_INTERVAL_MS);
    } else {
      console.log("Daily portfolio report scheduler disabled");
    }
    if (
      LINE_STOCK_PUSH_ENABLED &&
      DAILY_CHIP_MOVEMENT_ENABLED &&
      DAILY_CHIP_MOVEMENT_TIMES.length > 0
    ) {
      console.log(
        `Daily chip movement scheduler enabled. Times: ${DAILY_CHIP_MOVEMENT_TIMES.join(
          ", "
        )}`
      );
      setInterval(() => {
        checkAndPushDailyChipMovementReports().catch((error) => {
          console.error("Daily chip movement schedule failed:", error);
        });
      }, DAILY_REPORT_INTERVAL_MS);
    } else {
      console.log("Daily chip movement scheduler disabled");
    }
    setTimeout(() => {
      checkAndRepairWebCloudState()
        .then((result) => {
          if (result?.repaired) {
            console.warn("Web cloud state repaired on startup:", result);
          }
        })
        .catch((error) => {
          console.error("Web cloud state startup integrity check failed:", error);
        });
    }, 5000);
    setInterval(() => {
      checkAndRepairWebCloudState()
        .then((result) => {
          if (result?.repaired) {
            console.warn("Web cloud state auto-repaired:", result);
          }
        })
        .catch((error) => {
          console.error("Web cloud state integrity check failed:", error);
        });
    }, WEB_CLOUD_REPAIR_INTERVAL_MS);
  } else {
    console.log("Auto price alerts disabled: database is not enabled");
  }
});
