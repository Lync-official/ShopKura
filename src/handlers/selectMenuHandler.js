const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const pool = require('../db/pool');
const { getSettings } = require('../services/settingsService');
const { refreshVendingPanels } = require('../services/vendingService');

async function handleSelectMenu(interaction) {
  if (interaction.customId.startsWith('vshop_select_')) {
    const prodId = interaction.values[0];

    try {
      const res = await pool.query('SELECT * FROM products WHERE id = $1', [prodId]);
      if (res.rowCount === 0) {
        return interaction.update({ content: 'この商品は存在しないか、既に削除されています。', embeds: [], components: [] });
      }

      const prod = res.rows[0];
      if (!prod.infinite_stock && (!prod.stock || prod.stock.length === 0)) {
        return interaction.update({ content: `${prod.name} は売り切れです。`, embeds: [], components: [] });
      }

      // 支払金額が0円（無料商品）の場合は決済手続きを省略し、その場で商品を配布する
      if (Number(prod.price) === 0) {
        await interaction.deferUpdate();

        const dbClient = await pool.connect();
        try {
          await dbClient.query('BEGIN');

          const prodRes = await dbClient.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [prodId]);
          if (prodRes.rowCount === 0) {
            throw new Error('商品が存在しません。');
          }
          const lockedProd = prodRes.rows[0];

          let deliveredItem;
          if (lockedProd.infinite_stock) {
            // 在庫∞商品：在庫配列は消費せず、テンプレートとして使い回す
            deliveredItem = (lockedProd.stock && lockedProd.stock.length > 0) ? lockedProd.stock[0] : '(配布データ未登録。管理者に問い合わせてください)';
          } else {
            if (!lockedProd.stock || lockedProd.stock.length === 0) {
              throw new Error('商品の在庫がありません。');
            }
            const stock = [...lockedProd.stock];
            deliveredItem = stock.shift();
            await dbClient.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, prodId]);
          }

          await dbClient.query('COMMIT');

          const dmEmbed = new EmbedBuilder()
            .setTitle('ご購入ありがとうございます（無料商品）')
            .setDescription(`${lockedProd.name} は無料商品のため、決済手続きなしで商品データをお届けします。`)
            .setColor(0x8A2BE2)
            .addFields(
              { name: '購入商品ID', value: prodId, inline: true },
              { name: '商品データ', value: `\`\`\`${deliveredItem}\`\`\`` }
            )
            .setTimestamp();

          await interaction.user.send({ embeds: [dmEmbed] }).catch(() => {
            throw new Error('ユーザーへのDM送信に失敗しました。DMを開放してください。');
          });

          await interaction.editReply({ content: `${lockedProd.name} を受け取りました。DMをご確認ください。`, embeds: [], components: [] });

          await refreshVendingPanels(lockedProd.vending_id);
        } catch (error) {
          await dbClient.query('ROLLBACK');
          console.error('無料商品配布エラー:', error);
          await interaction.editReply({ content: `処理に失敗しました: ${error.message}`, embeds: [], components: [] }).catch(() => null);
        } finally {
          dbClient.release();
        }

        return;
      }

      // 有料商品：従来通りPayPay支払いモーダルを表示する
      const settings = await getSettings();
      if (!settings.payment_channel_id) {
        return interaction.update({ content: '管理者が決済確認チャンネルを設定していないため、購入手続きを開始できません。', embeds: [], components: [] });
      }

      const modal = new ModalBuilder()
        .setCustomId(`pay_modal_${prodId}`)
        .setTitle('PayPay支払い手続き');

      const urlInput = new TextInputBuilder()
        .setCustomId('paypay_url')
        .setLabel(`送金リンク (${prod.price} 円を支払ってください)`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://paypay.ne.jp/qr/...')
        .setRequired(true);

      const modalRow = new ActionRowBuilder().addComponents(urlInput);
      modal.addComponents(modalRow);

      await interaction.showModal(modal);
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '購入処理の開始中にエラーが発生しました。', ephemeral: true }).catch(() => null);
    }
  }
}

module.exports = handleSelectMenu;
