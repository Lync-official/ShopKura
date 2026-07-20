const http = require('http');
const config = require('../config');

// Renderデプロイ用の簡易ステータスWebサーバー
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShopKura Bot Status</title>
    <style>
        body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            background-color: #0f0f15;
            color: #e0e0e6;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: #161622;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }
        h1 {
            color: #8A2BE2;
            margin-bottom: 10px;
        }
        p {
            font-size: 1.1em;
            color: #a0a0b0;
        }
        .status {
            display: inline-block;
            padding: 8px 16px;
            background-color: #00FF88;
            color: #0f0f15;
            border-radius: 4px;
            font-weight: bold;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ShopKura</h1>
        <p>Discord Bot is active</p>
        <span class="status">ONLINE</span>
    </div>
</body>
</html>
`;

function startStatusServer() {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  }).listen(config.PORT, () => {
    console.log(`Webサーバーがポート ${config.PORT} で起動しました。`);
  });
}

module.exports = startStatusServer;
