const { REST, Routes } = require('discord.js');
const config = require('../config');
const commands = require('./definitions');

async function registerCommands(clientId) {
  const token = config.DISCORD_TOKEN;

  if (!token || token.includes('YOUR_DISCORD')) {
    console.warn('警告: DISCORD_TOKEN が設定されていません。');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('アプリケーションコマンドの再登録を開始します...');
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
    console.log('アプリケーションコマンドの登録に成功しました。');
  } catch (error) {
    console.error('コマンド登録中にエラーが発生しました:', error);
  }
}

module.exports = { registerCommands };
