const http = require('http');
const config = require('../config');
const pool = require('../db/pool');
const client = require('../client');

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

function renderResponseHtml(title, message, isSuccess = true) {
  const statusColor = isSuccess ? '#00FF88' : '#FF3B30';
  const statusText = isSuccess ? 'SUCCESS' : 'ERROR';
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
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
            max-width: 450px;
            width: 90%;
        }
        h1 {
            color: #8A2BE2;
            margin-bottom: 15px;
            font-size: 1.8em;
        }
        p {
            font-size: 1.1em;
            color: #a0a0b0;
            line-height: 1.6;
        }
        .status {
            display: inline-block;
            padding: 8px 16px;
            background-color: ${statusColor};
            color: #0f0f15;
            border-radius: 4px;
            font-weight: bold;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
        <span class="status">${statusText}</span>
    </div>
</body>
</html>
  `;
}

async function handleOAuthCallback(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = reqUrl.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderResponseHtml('認証エラー', '認証コード(code)が見つかりませんでした。もう一度やり直してください。', false));
    return;
  }

  try {
    const clientId = config.DISCORD_CLIENT_ID || client.application?.id;
    if (!clientId || !config.DISCORD_CLIENT_SECRET || !config.DISCORD_REDIRECT_URI) {
      throw new Error('BotサーバーのOAuth2環境変数が正しく設定されていません。');
    }

    // 1. OAuth2コードからトークンを取得
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.DISCORD_REDIRECT_URI,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!tokenResponse.ok) {
      const errData = await tokenResponse.json().catch(() => ({}));
      throw new Error(`トークン取得に失敗しました: ${errData.error_description || tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    // 2. ユーザーIDを取得
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error('ユーザー情報の取得に失敗しました。');
    }

    const userData = await userResponse.json();
    const userId = userData.id;

    // 3. データベースにOAuth2情報を保存
    const expiresAt = Date.now() + (expires_in * 1000);
    await pool.query(
      `INSERT INTO oauth_users (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at`,
      [userId, access_token, refresh_token, expiresAt]
    );

    // 4. サーバーへ参加、または認証ロールを付与
    const guildId = config.ALLOWED_GUILD_ID;
    const guild = await client.guilds.fetch(guildId).catch(() => null);

    if (!guild) {
      throw new Error('対象のDiscordサーバーが見つかりませんでした。Botがサーバーに存在しているか確認してください。');
    }

    let member = await guild.members.fetch(userId).catch(() => null);

    if (!member) {
      // guilds.join 権限を使ってメンバーをサーバーに強制参加させる
      const joinResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({
          access_token: access_token,
          roles: [config.VERIFIED_ROLE_ID] // 初期ロールを付与して参加させる
        }),
        headers: {
          Authorization: `Bot ${config.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      if (!joinResponse.ok && joinResponse.status !== 201 && joinResponse.status !== 204) {
        const joinErr = await joinResponse.json().catch(() => ({}));
        console.error('サーバー追加APIエラー:', joinErr);
        throw new Error('サーバーへの追加（参加）処理に失敗しました。ボットの権限を確認してください。');
      }
    } else {
      // すでにサーバー内にいる場合はロールのみを付与する
      if (!member.roles.cache.has(config.VERIFIED_ROLE_ID)) {
        await member.roles.add(config.VERIFIED_ROLE_ID);
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderResponseHtml(
      '認証連携 成功',
      `${userData.username}#${userData.discriminator || '0'} さんのアカウント連携とサーバー認証が正常に完了しました！<br>Discordに戻ってチャンネルが表示されているかご確認ください。`,
      true
    ));

  } catch (error) {
    console.error('OAuthコールバックエラー:', error);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderResponseHtml('認証エラー', error.message || '連携中に予期せぬエラーが発生しました。', false));
  }
}

function startStatusServer() {
  http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // OAuthコールバックのパス判定
    if (reqUrl.pathname === '/oauth/callback') {
      return handleOAuthCallback(req, res);
    }

    // デフォルトのステータス表示
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  }).listen(config.PORT, () => {
    console.log(`Webサーバーがポート ${config.PORT} で起動しました。`);
  });
}

module.exports = startStatusServer;
