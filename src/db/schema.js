const pool = require('./pool');

// データベーステーブル初期化
async function initDb() {
  const dbClient = await pool.connect();
  try {
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(255) PRIMARY KEY,
        vending_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        price INTEGER NOT NULL,
        description TEXT NOT NULL,
        stock TEXT[] NOT NULL DEFAULT '{}'
      );
    `);
    await dbClient.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS infinite_stock BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS pending_transactions (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        product_id VARCHAR(255) NOT NULL,
        paypay_url TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        vouch_channel_id VARCHAR(255),
        payment_channel_id VARCHAR(255)
      );
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS vending_panels (
        message_id VARCHAR(255) PRIMARY KEY,
        channel_id VARCHAR(255) NOT NULL,
        vending_id VARCHAR(255) NOT NULL
      );
    `);
    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_vending_panels_vending_id ON vending_panels (vending_id);
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS oauth_users (
        user_id VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await dbClient.query(`
      INSERT INTO settings (key, vouch_channel_id, payment_channel_id)
      VALUES ('guildSettings', NULL, NULL)
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('Supabase データベーステーブルの初期化が完了しました。');
  } catch (err) {
    console.error('データベース初期化エラー:', err);
  } finally {
    dbClient.release();
  }
}

module.exports = { initDb };
