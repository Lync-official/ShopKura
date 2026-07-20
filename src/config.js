require('dotenv').config();

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT || 3000,

  // このサーバー以外には参加しない（自動退出する）
  ALLOWED_GUILD_ID: process.env.ALLOWED_GUILD_ID || '1528260161683062826',

  // 認証機能: 未認証ユーザーでも最初から見えるチャンネル（認証パネルを置くチャンネル）
  VERIFY_CHANNEL_ID: process.env.VERIFY_CHANNEL_ID || '1528283956640743565',

  // 認証機能: このロールが付与されると、プライベートチャンネル以外の全チャンネルが見えるようになる
  VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID || '1528290460932509729',

  // 認証ロールを持っていても見えないままにしたいチャンネルID（カンマ区切りで.envに追加可能）
  // 例: PRIVATE_CHANNEL_IDS=111111111111111111,222222222222222222
  // 注: ticket-〇〇 という名前のチケットチャンネルは名前で自動的に除外されるため、ここに追加する必要はない
  PRIVATE_CHANNEL_IDS: (process.env.PRIVATE_CHANNEL_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
};
