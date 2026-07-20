const pool = require('../db/pool');

// 設定取得ヘルパー
async function getSettings() {
  try {
    const res = await pool.query("SELECT vouch_channel_id, payment_channel_id FROM settings WHERE key = 'guildSettings'");
    return res.rows[0] || { vouch_channel_id: null, payment_channel_id: null };
  } catch (err) {
    console.error('設定取得エラー:', err);
    return { vouch_channel_id: null, payment_channel_id: null };
  }
}

module.exports = { getSettings };
