const express = require('express');
const path = require('path');
const app = express();

// 1. 先處理靜態檔案（這行在最前面，CSS/JS 才讀得到）
app.use(express.static(__dirname));

// 2. 明確指定首頁
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 3. 備用路由，避免 SPA 斷線
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. 綁定 Railway 要求的 Port
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
