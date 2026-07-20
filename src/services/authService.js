const { ChannelType } = require('discord.js');
const config = require('../config');
const pool = require('../db/pool');

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

// トークンをリフレッシュする関数
async function refreshUserToken(userId, refreshToken) {
  try {
    const clientId = config.DISCORD_CLIENT_ID;
    if (!clientId || !config.DISCORD_CLIENT_SECRET) {
      throw new Error('OAuth2クライアント情報が設定されていません。');
    }

    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`トークンのリフレッシュに失敗しました: ${errData.error_description || response.statusText}`);
    }

    const data = await response.json();
    const expiresAt = Date.now() + (data.expires_in * 1000);

    await pool.query(
      `UPDATE oauth_users 
       SET access_token = $1, refresh_token = $2, expires_at = $3
       WHERE user_id = $4`,
      [data.access_token, data.refresh_token, expiresAt, userId]
    );

    return data.access_token;
  } catch (error) {
    console.error(`ユーザー ${userId} のトークン更新エラー:`, error);
    throw error;
  }
}

// ユーザーをサーバーに引き戻す（再参加させる）関数
async function rejoinMember(guildId, userId) {
  try {
    // DBからOAuth2情報を取得
    const res = await pool.query('SELECT * FROM oauth_users WHERE user_id = $1', [userId]);
    if (res.rowCount === 0) {
      console.log(`ユーザー ${userId} のOAuth2連携データがありません。`);
      return false;
    }

    let { access_token, refresh_token, expires_at } = res.rows[0];

    // トークン期限が切れているか、残り5分未満なら更新
    const bufferTime = 5 * 60 * 1000;
    if (Date.now() + bufferTime >= Number(expires_at)) {
      console.log(`ユーザー ${userId} のアクセストークンが期限切れのため、リフレッシュします。`);
      try {
        access_token = await refreshUserToken(userId, refresh_token);
      } catch (err) {
        console.error(`ユーザー ${userId} のトークンリフレッシュ失敗、既存のトークンで試みます:`, err);
      }
    }

    // guilds.join APIを叩く
    const joinResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({
        access_token: access_token,
        roles: [config.VERIFIED_ROLE_ID]
      }),
      headers: {
        Authorization: `Bot ${config.DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (joinResponse.ok || joinResponse.status === 201 || joinResponse.status === 204) {
      console.log(`ユーザー ${userId} をサーバーに追加/復旧しました。ステータス: ${joinResponse.status}`);
      return true;
    } else {
      const err = await joinResponse.json().catch(() => ({}));
      console.error(`ユーザー ${userId} の再参加に失敗しました:`, err);
      return false;
    }
  } catch (error) {
    console.error(`ユーザー ${userId} の再参加処理中にエラーが発生しました:`, error);
    return false;
  }
}

module.exports = { 
  verifyMember, 
  lockdownGuildChannels,
  refreshUserToken,
  rejoinMember
};
