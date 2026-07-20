const { Pool } = require('pg');
const config = require('../config');

// Supabase (PostgreSQL) の接続プール
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Supabase接続用
  }
});

module.exports = pool;
