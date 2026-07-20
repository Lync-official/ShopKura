const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const client = require('../client');
const pool = require('../db/pool');

// 自販機パネル（embed + 「購入する」ボタン1つ）生成ヘルパー
// 商品が0件の自販機IDでも「商品なし」パネルを返す（設置後に商品を追加すれば自動反映されるため）
// 商品ごとの購入ボタンは置かず、「購入する」ボタンを押すと本人にしか見えない商品選択メニューを表示する方式にしている
async function buildVendingPanel(vendingId) {
  const res = await pool.query('SELECT * FROM products WHERE vending_id = $1 ORDER BY name', [vendingId]);

  if (res.rowCount === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`ShopKura オンライン自販機「${vendingId}」`)
      .setDescription('現在この自販機には商品が登録されていません。商品が追加され次第、このパネルは自動的に更新されます。')
      .setColor(0x8A2BE2)
      .setTimestamp();
    return { isEmpty: true, embed, rows: [] };
  }

  const embed = new EmbedBuilder()
    .setTitle(`ShopKura オンライン自販機「${vendingId}」`)
    .setDescription('下の「購入する」ボタンを押すと、あなたにしか見えない商品選択メニューが表示されます。そこから購入したい商品を選択してください。お支払いはPayPay送金リンクのみ受け付けております（無料商品は決済不要で即時お届けします）。')
    .setColor(0x8A2BE2)
    .setTimestamp();

  let allOutOfStock = true;

  res.rows.forEach((prod) => {
    const stockLabel = prod.infinite_stock ? '∞' : `${prod.stock ? prod.stock.length : 0} 個`;
    const outOfStock = !prod.infinite_stock && (!prod.stock || prod.stock.length === 0);
    if (!outOfStock) allOutOfStock = false;
    const priceLabel = Number(prod.price) === 0 ? '無料' : `${prod.price} 円`;

    embed.addFields({
      name: `${prod.name} (${priceLabel})${outOfStock ? ' 【売り切れ】' : ''}`,
      value: `商品ID: ${prod.id} | 在庫: ${stockLabel}\n説明: ${prod.description}`
    });
  });

  const buyButton = new ButtonBuilder()
    .setCustomId(`vshop_open_${vendingId}`)
    .setLabel('購入する')
    .setStyle(ButtonStyle.Success)
    .setDisabled(allOutOfStock);

  const rows = [new ActionRowBuilder().addComponents(buyButton)];

  return { isEmpty: false, embed, rows };
}

// 自販機ごとに複数設置されたパネル（複数チャンネル・複数メッセージ）を全て最新の在庫状態に同期する
async function refreshVendingPanels(vendingId) {
  if (!vendingId) return;

  try {
    const res = await pool.query('SELECT channel_id, message_id FROM vending_panels WHERE vending_id = $1', [vendingId]);
    if (res.rowCount === 0) return;

    const panel = await buildVendingPanel(vendingId);

    for (const row of res.rows) {
      try {
        const channel = await client.channels.fetch(row.channel_id);
        const message = await channel.messages.fetch(row.message_id);
        await message.edit({ embeds: [panel.embed], components: panel.rows });
      } catch (err) {
        // チャンネルやメッセージが手動削除されている場合は設置記録をクリーンアップする
        await pool.query('DELETE FROM vending_panels WHERE message_id = $1', [row.message_id]).catch(() => null);
      }
    }
  } catch (err) {
    console.error('自販機パネル自動更新エラー:', err);
  }
}

// 設置されている「全ての」自販機パネル（全自販機ID・全チャンネル・全メッセージ）を一斉に最新状態へ更新する
// 購入方式やパネルの見た目を変更した際に、個別のvending-setupやvending-addをやり直さずに一括反映するためのもの
async function refreshAllVendingPanels() {
  const result = { vendingCount: 0, success: 0, failed: 0 };

  const distinctRes = await pool.query('SELECT DISTINCT vending_id FROM vending_panels');
  result.vendingCount = distinctRes.rowCount;

  for (const row of distinctRes.rows) {
    const vendingId = row.vending_id;

    try {
      const panel = await buildVendingPanel(vendingId);
      const panelsRes = await pool.query('SELECT channel_id, message_id FROM vending_panels WHERE vending_id = $1', [vendingId]);

      for (const p of panelsRes.rows) {
        try {
          const channel = await client.channels.fetch(p.channel_id);
          const message = await channel.messages.fetch(p.message_id);
          await message.edit({ embeds: [panel.embed], components: panel.rows });
          result.success++;
        } catch (err) {
          // チャンネルやメッセージが手動削除されている場合は設置記録をクリーンアップする
          await pool.query('DELETE FROM vending_panels WHERE message_id = $1', [p.message_id]).catch(() => null);
          result.failed++;
        }
      }
    } catch (err) {
      console.error(`自販機「${vendingId}」の一斉更新中にエラー:`, err);
    }
  }

  return result;
}

module.exports = { buildVendingPanel, refreshVendingPanels, refreshAllVendingPanels };
