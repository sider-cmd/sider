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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =================【4. 啟動伺服器】=================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);      
});
