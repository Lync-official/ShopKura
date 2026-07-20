const { ChannelType } = require('discord.js');
const config = require('../config');

// メンバーに認証ロールを付与する
// すでに付与済みの場合は alreadyVerified: true を返す
async function verifyMember(member) {
  if (member.roles.cache.has(config.VERIFIED_ROLE_ID)) {
    return { alreadyVerified: true };
  }
  await member.roles.add(config.VERIFIED_ROLE_ID);
  return { alreadyVerified: false };
}

// サーバー内の各チャンネルの閲覧権限を「認証制」に一括設定する
// - 認証チャンネル(config.VERIFY_CHANNEL_ID): @everyone が見える状態にする
// - それ以外の通常チャンネル: @everyone は見えない／認証ロールを持つ人だけ見える状態にする
// - チケットチャンネル（"ticket-"から始まる名前。本人専用の個別権限を持つ）や
//   PRIVATE_CHANNEL_IDS に指定したチャンネル、PRIVATE_CATEGORY_IDS 配下のチャンネル
//   （管理者専用カテゴリなど）はスキップし、既存の権限を手動管理のまま変更しない
async function lockdownGuildChannels(guild) {
  const result = { updated: 0, skipped: 0, failed: 0 };
  const channels = await guild.channels.fetch();

  for (const [, channel] of channels) {
    if (!channel || channel.type === ChannelType.GuildCategory) continue;

    const isTicketChannel = typeof channel.name === 'string' && channel.name.startsWith('ticket-');
    const isExcluded = config.PRIVATE_CHANNEL_IDS.includes(channel.id);
    const isInPrivateCategory = channel.parentId && config.PRIVATE_CATEGORY_IDS.includes(channel.parentId);

    if (isTicketChannel || isExcluded || isInPrivateCategory) {
      result.skipped++;
      continue;
    }

    try {
      if (channel.id === config.VERIFY_CHANNEL_ID) {
        // 認証チャンネル自体は未認証ユーザーにも見える状態にする
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
      } else {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      }
      await channel.permissionOverwrites.edit(config.VERIFIED_ROLE_ID, { ViewChannel: true });
      result.updated++;
    } catch (err) {
      console.error(`チャンネル(${channel.id})の権限設定エラー:`, err);
      result.failed++;
    }
  }

  return result;
}

module.exports = { verifyMember, lockdownGuildChannels };
