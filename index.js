const dns = require('dns');
// Render等のIPv6環境がないサーバーでSupabaseへの接続エラー(ENETUNREACH)を防ぐため、IPv4を優先に設定
dns.setDefaultResultOrder('ipv4first');

const client = require('./src/client');
const config = require('./src/config');
const { initDb } = require('./src/db/schema');
const { registerCommands } = require('./src/commands/register');
const startStatusServer = require('./src/web/statusServer');

const handleAutocomplete = require('./src/handlers/autocompleteHandler');
const handleChatInputCommand = require('./src/handlers/chatInputCommandHandler');
const handleButton = require('./src/handlers/buttonHandler');
const handleModalSubmit = require('./src/handlers/modalHandler');
const handleSelectMenu = require('./src/handlers/selectMenuHandler');
const { buildJoinEmbed, buildLeaveEmbed } = require('./src/services/memberLogService');

client.once('ready', async () => {
  console.log(`ログインしました: ${client.user.tag}`);
  await initDb();

  // 許可されたサーバー以外のギルドから退出する
  client.guilds.cache.forEach(async (guild) => {
    if (guild.id !== config.ALLOWED_GUILD_ID) {
      console.log(`許可されていないサーバー (${guild.name} / ID: ${guild.id}) から退出します。`);
      await guild.leave().catch(err => console.error('サーバー退出エラー:', err));
    }
  });

  // ログイン情報からアプリケーションID（クライアントID）を自動で取得
  const clientId = client.application.id;
  await registerCommands(clientId);
});

// 新しいサーバーに追加されたときの処理
client.on('guildCreate', async (guild) => {
  if (guild.id !== config.ALLOWED_GUILD_ID) {
    console.log(`許可されていないサーバー (${guild.name} / ID: ${guild.id}) に追加されたため、即座に退出します。`);
    await guild.leave().catch(err => console.error('サーバー退出エラー:', err));
  }
});

// 入退室ログ: メンバー参加
client.on('guildMemberAdd', async (member) => {
  try {
    const logChannel = await client.channels.fetch(config.JOIN_LEAVE_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;
    await logChannel.send({ embeds: [buildJoinEmbed(member)] });
  } catch (err) {
    console.error('入室ログ送信エラー:', err);
  }
});

// 入退室ログ: メンバー退出
client.on('guildMemberRemove', async (member) => {
  try {
    const logChannel = await client.channels.fetch(config.JOIN_LEAVE_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;
    await logChannel.send({ embeds: [buildLeaveEmbed(member)] });
  } catch (err) {
    console.error('退室ログ送信エラー:', err);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    // 自販機名の入力補完（既存の自販機名を候補に出す。一致しなければ新しい名前として新規作成できる）
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction);
    }

    // スラッシュコマンド
    if (interaction.isChatInputCommand()) {
      return handleChatInputCommand(interaction);
    }

    // ボタンイベント
    if (interaction.isButton()) {
      return handleButton(interaction);
    }

    // モーダル入力イベント
    if (interaction.isModalSubmit()) {
      return handleModalSubmit(interaction);
    }

    // セレクトメニューイベント（自販機の商品選択）
    if (interaction.isStringSelectMenu()) {
      return handleSelectMenu(interaction);
    }
  } catch (err) {
    console.error('interactionCreate 処理中に予期しないエラーが発生しました:', err);
  }
});

client.on('error', error => console.error('Discord Client Error:', error));
process.on('unhandledRejection', error => console.error('Unhandled Promise Rejection:', error));

startStatusServer();

const token = config.DISCORD_TOKEN;
if (token && !token.includes('YOUR_DISCORD')) {
  client.login(token);
} else {
  console.log('ボットを起動するには、.envファイルに DISCORD_TOKEN を設定してください。');
}
