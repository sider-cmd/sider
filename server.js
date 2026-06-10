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
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: BOT_BUILD_VERSION,
    portfolioDb: hasPortfolioDb
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/alerts/check', async (req, res) => {
  try {
    await checkAndPushPriceAlerts();
    await checkAndPushTieredCostAlerts();
    res.json({ ok: true });
  } catch (error) {
    console.error("手動觸發價格提醒失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/intraday/check', async (req, res) => {
  try {
    await checkAndPushIntradayBriefs(true);
    res.json({ ok: true });
  } catch (error) {
    console.error("手動觸發盤中持股快訊失敗:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/daily-report/check', async (req, res) => {
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

app.get('/intraday/anomaly/check', async (req, res) => {
  try {
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
      checkAndPushTieredCostAlerts().catch((error) => {
        console.error("Tiered cost alerts auto check failed:", error);
      });
    }, ALERT_CHECK_INTERVAL_MS);
    if (INTRADAY_PUSH_ENABLED && INTRADAY_PUSH_TIMES.length > 0) {
      console.log(
        `Intraday portfolio briefs enabled. Times: ${INTRADAY_PUSH_TIMES.join(
          ", "
        )}`
      );
      setInterval(() => {
        checkAndPushIntradayBriefs().catch((error) => {
          console.error("盤中持股快訊排程失敗:", error);
        });
      }, INTRADAY_PUSH_INTERVAL_MS);
    } else {
      console.log("Intraday portfolio briefs disabled");
    }
    if (INTRADAY_ANOMALY_ENABLED) {
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
    console.log("Auto price alerts disabled: database is not enabled");
  }
});
