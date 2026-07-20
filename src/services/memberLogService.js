const { EmbedBuilder } = require('discord.js');

// ミリ秒を「〇日 〇時間」のような読みやすい文字列に変換する
function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}日 ${hours}時間`;
  if (hours > 0) return `${hours}時間 ${minutes}分`;
  return `${minutes}分`;
}

// 参加通知用の埋め込み
function buildJoinEmbed(member) {
  const user = member.user;
  const createdTimestampSec = Math.floor(user.createdTimestamp / 1000);
  const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86400000);

  // アカウント作成から7日未満のユーザーは注意喚起として色を変える
  const isNewAccount = accountAgeDays < 7;

  return new EmbedBuilder()
    .setColor(isNewAccount ? 0xF39C12 : 0x00FF88)
    .setAuthor({ name: `${member.guild.name} に新しいメンバーが参加しました`, iconURL: member.guild.iconURL() ?? undefined })
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(`${user} さん、ようこそ！\n楽しんでいってください 🎉`)
    .addFields(
      { name: '👤 ユーザー', value: `${user.tag}`, inline: true },
      { name: '🆔 ユーザーID', value: `${user.id}`, inline: true },
      { name: '📈 現在のメンバー数', value: `${member.guild.memberCount} 人`, inline: true },
      { name: '🗓️ アカウント作成日', value: `<t:${createdTimestampSec}:D>（${accountAgeDays}日前）${isNewAccount ? '\n⚠️ 作成から日が浅いアカウントです' : ''}`, inline: false }
    )
    .setFooter({ text: 'ShopKura 入退室ログ', iconURL: member.guild.iconURL() ?? undefined })
    .setTimestamp();
}

// 退出通知用の埋め込み
function buildLeaveEmbed(member) {
  const user = member.user ?? member;
  const guild = member.guild;

  let stayField = '不明（キャッシュにデータがありません）';
  if (member.joinedTimestamp) {
    const joinedTimestampSec = Math.floor(member.joinedTimestamp / 1000);
    stayField = `<t:${joinedTimestampSec}:D> から在籍\n（${formatDuration(Date.now() - member.joinedTimestamp)}）`;
  }

  const roleNames = member.roles?.cache
    ? member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).slice(0, 10)
    : [];

  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setAuthor({ name: `${guild.name} からメンバーが退出しました`, iconURL: guild.iconURL() ?? undefined })
    .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL({ size: 256 }) : null)
    .setDescription(`**${user.tag ?? user.username ?? '不明なユーザー'}** さんが退出しました。`)
    .addFields(
      { name: '🆔 ユーザーID', value: `${user.id}`, inline: true },
      { name: '📉 現在のメンバー数', value: `${guild.memberCount} 人`, inline: true },
      { name: '⏳ 在籍期間', value: stayField, inline: false },
      ...(roleNames.length > 0 ? [{ name: '🎭 保有していたロール', value: roleNames.join(', ') }] : [])
    )
    .setFooter({ text: 'ShopKura 入退室ログ', iconURL: guild.iconURL() ?? undefined })
    .setTimestamp();
}

module.exports = { buildJoinEmbed, buildLeaveEmbed };
