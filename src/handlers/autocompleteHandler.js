const pool = require('../db/pool');

// 自販機名の入力補完（既存の自販機名を候補に出す。一致しなければ新しい名前として新規作成できる）
async function handleAutocomplete(interaction) {
  if (['vending-add', 'vending-list', 'vending-setup'].includes(interaction.commandName)) {
    const focusedValue = interaction.options.getFocused() || '';
    try {
      const res = await pool.query(
        'SELECT DISTINCT vending_id FROM products WHERE vending_id ILIKE $1 ORDER BY vending_id LIMIT 25',
        [`%${focusedValue}%`]
      );
      await interaction.respond(res.rows.map(row => ({ name: row.vending_id, value: row.vending_id })));
    } catch (err) {
      console.error('自販機名自動補完エラー:', err);
      await interaction.respond([]).catch(() => null);
    }
  }
}

module.exports = handleAutocomplete;
