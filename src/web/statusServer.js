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
  const iconColor = isSuccess ? '#00FF88' : '#FF3B30';
  const glowColor = isSuccess ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 59, 48, 0.2)';
  
  // SVGアイコン定義
  const successIcon = `
    <svg class="icon svg-success" viewBox="0 0 52 52">
      <circle class="icon-circle" cx="26" cy="26" r="25" fill="none"/>
      <path class="icon-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
    </svg>
  `;
  const errorIcon = `
    <svg class="icon svg-error" viewBox="0 0 52 52">
      <circle class="icon-circle" cx="26" cy="26" r="25" fill="none"/>
      <path class="icon-cross-1" fill="none" d="M16 16l20 20"/>
      <path class="icon-cross-2" fill="none" d="M36 16L16 36"/>
    </svg>
  `;

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | ShopKura</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
    <style>
        :root {
            --bg-color: #0b0b10;
            --card-bg: rgba(22, 22, 34, 0.45);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-color: #8A2BE2;
            --text-primary: #f3f3f6;
            --text-secondary: #a0a0b8;
            --status-color: ${iconColor};
        }

        body {
            font-family: 'Outfit', 'Noto Sans JP', sans-serif;
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(138, 43, 226, 0.15) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, ${glowColor} 0%, transparent 45%);
            color: var(--text-primary);
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            overflow: hidden;
            perspective: 1000px;
        }

        /* 背景のアニメーション効果 */
        body::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(135deg, rgba(15,15,25,0) 0%, rgba(138, 43, 226, 0.05) 50%, rgba(15,15,25,0) 100%);
            background-size: 400% 400%;
            animation: gradientMove 15s ease infinite;
            z-index: -1;
        }

        @keyframes gradientMove {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }

        .container {
            text-align: center;
            padding: 50px 40px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 24px;
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            box-shadow: 
                0 20px 50px rgba(0, 0, 0, 0.4),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            max-width: 460px;
            width: 85%;
            transform: translateY(30px) rotateX(10deg);
            opacity: 0;
            animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes fadeInUp {
            to {
                transform: translateY(0) rotateX(0);
                opacity: 1;
            }
        }

        /* SVGアイコンアニメーション */
        .icon-wrapper {
            width: 80px;
            height: 80px;
            margin: 0 auto 30px;
            position: relative;
        }

        .icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            display: block;
            stroke-width: 3;
            stroke: var(--status-color);
            stroke-miterlimit: 10;
            box-shadow: inset 0px 0px 0px var(--status-color);
            animation: fillIcon .4s ease-in-out .4s forwards, scaleIcon .3s ease-in-out .9s both;
        }

        .icon-circle {
            stroke-dasharray: 166;
            stroke-dashoffset: 166;
            stroke-width: 3;
            stroke-miterlimit: 10;
            stroke: var(--status-color);
            fill: none;
            animation: strokeCircle .6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
        }

        .icon-check {
            transform-origin: 50% 50%;
            stroke-dasharray: 48;
            stroke-dashoffset: 48;
            animation: strokeCheck .3s cubic-bezier(0.65, 0, 0.45, 1) .8s forwards;
        }

        .icon-cross-1, .icon-cross-2 {
            transform-origin: 50% 50%;
            stroke-dasharray: 48;
            stroke-dashoffset: 48;
        }

        .icon-cross-1 {
            animation: strokeCheck .3s cubic-bezier(0.65, 0, 0.45, 1) .7s forwards;
        }
        .icon-cross-2 {
            animation: strokeCheck .3s cubic-bezier(0.65, 0, 0.45, 1) .9s forwards;
        }

        @keyframes strokeCircle {
            100% { stroke-dashoffset: 0; }
        }

        @keyframes strokeCheck {
            100% { stroke-dashoffset: 0; }
        }

        @keyframes scaleIcon {
            0%, 100% { transform: none; }
            50% { transform: scale3d(1.1, 1.1, 1); }
        }

        @keyframes fillIcon {
            100% { box-shadow: inset 0px 0px 0px 40px rgba(255, 255, 255, 0); }
        }

        h1 {
            font-size: 2.2em;
            font-weight: 800;
            background: linear-gradient(135deg, #ffffff 0%, var(--text-secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 20px;
            letter-spacing: -0.5px;
        }

        p {
            font-size: 1.1em;
            color: var(--text-secondary);
            line-height: 1.7;
            margin-bottom: 30px;
            font-weight: 400;
        }

        .close-hint {
            font-size: 0.85em;
            color: rgba(255, 255, 255, 0.35);
            margin-top: 25px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            padding-top: 20px;
        }

        .status-badge {
            display: inline-block;
            font-size: 0.8em;
            font-weight: 800;
            letter-spacing: 1.5px;
            padding: 6px 16px;
            border-radius: 30px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            color: var(--status-color);
            box-shadow: 0 0 15px rgba(255, 255, 255, 0.01);
            text-transform: uppercase;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon-wrapper">
            ${isSuccess ? successIcon : errorIcon}
        </div>
        <h1>${title}</h1>
        <p>${message}</p>
        <span class="status-badge">${isSuccess ? 'Verified' : 'Failed'}</span>
        <div class="close-hint">このタブは閉じてしまって構いません。</div>
    </div>

    <script>
        // 成功時に紙吹雪を舞わせる
        if (${isSuccess}) {
            const duration = 3 * 1000;
            const end = Date.now() + duration;

            (function frame() {
                confetti({
                    particleCount: 3,
                    angle: 60,
                    spread: 55,
                    origin: { x: 0, y: 0.85 },
                    colors: ['#8A2BE2', '#00FF88', '#00E5FF']
                });
                confetti({
                    particleCount: 3,
                    angle: 120,
                    spread: 55,
                    origin: { x: 1, y: 0.85 },
                    colors: ['#8A2BE2', '#00FF88', '#00E5FF']
                });

                if (Date.now() < end) {
                    requestAnimationFrame(frame);
                }
            }());
        }
    </script>
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
