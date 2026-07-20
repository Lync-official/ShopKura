const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pool = require('../db/pool');
const { getSettings } = require('../services/settingsService');
const { verifyPayPayLink } = require('../services/paypayService');

async function handleModalSubmit(interaction) {
  const settings = await getSettings();

  // 実績報告モーダル
  if (interaction.customId === 'vouch_modal') {
    const vouchChannelId = settings.vouch_channel_id;

    if (!vouchChannelId) {
      return interaction.reply({ content: '実績報告を受け取るチャンネルが設定されていません。管理者が 実績受け取り コマンドを実行して設定してください。', ephemeral: true });
    }

    const product = interaction.fields.getTextInputValue('vouch_product');
    const quantity = interaction.fields.getTextInputValue('vouch_quantity');
    const review = interaction.fields.getTextInputValue('vouch_review');
    const ratingVal = interaction.fields.getTextInputValue('vouch_rating');

    const vouchChannel = interaction.guild.channels.cache.get(vouchChannelId);
    if (!vouchChannel) {
      return interaction.reply({ content: '設定された実績受け取りチャンネルが見つかりませんでした。再度 実績受け取り コマンドで設定し直してください。', ephemeral: true });
    }

    const clampedRating = Math.max(1, Math.min(5, parseInt(ratingVal) || 5));
    const ratingString = '星' + clampedRating;

    const embed = new EmbedBuilder()
      .setTitle('新しい実績（レビュー）が届きました')
      .setColor(0xFFD700)
      .addFields(
        { name: '投稿者', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
        { name: '購入商品', value: product, inline: true },
        { name: '個数', value: quantity, inline: true },
        { name: '評価', value: ratingString, inline: true },
        { name: '感想', value: review }
      )
      .setTimestamp();

    try {
      await vouchChannel.send({ embeds: [embed] });
      return interaction.reply({ content: '実績を報告しました。ご協力ありがとうございました。', ephemeral: true });
    } catch (error) {
      console.error('実績送信エラー:', error);
      return interaction.reply({ content: '実績の送信中にエラーが発生しました。ボットの権限を確認してください。', ephemeral: true });
    }
  }

  // PayPay送金リンク決済モーダル
  if (interaction.customId.startsWith('pay_modal_')) {
    const prodId = interaction.customId.replace('pay_modal_', '');
    const paypayUrl = interaction.fields.getTextInputValue('paypay_url');

    try {
      const prodRes = await pool.query('SELECT * FROM products WHERE id = $1', [prodId]);
      if (prodRes.rowCount === 0) {
        return interaction.reply({ content: 'この商品は存在しないか、既に削除されています。', ephemeral: true });
      }

      const prod = prodRes.rows[0];

      const paymentChannel = interaction.guild.channels.cache.get(settings.payment_channel_id);
      if (!paymentChannel) {
        return interaction.reply({ content: '決済確認チャンネルが見つかりません。管理者に確認してください。', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      // PayPay自動検証
      const validation = await verifyPayPayLink(paypayUrl, prod.price);
      if (!validation.valid) {
        return interaction.editReply({ content: `申請を送信できませんでした: ${validation.reason}` });
      }

      const transactionId = `tx_${Date.now()}_${interaction.user.id}`;

      // トランザクション情報を保存
      await pool.query(`
        INSERT INTO pending_transactions (id, user_id, product_id, paypay_url, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [transactionId, interaction.user.id, prodId, paypayUrl, Date.now()]);

      const requestEmbed = new EmbedBuilder()
        .setTitle('購入申請 (PayPay支払い)')
        .setColor(0xF39C12)
        .addFields(
          { name: '購入者', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
          { name: '商品名', value: prod.name, inline: true },
          { name: '価格', value: `${prod.price} 円`, inline: true },
          { name: 'PayPay送金リンク', value: paypayUrl }
        )
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pay_approve_${transactionId}`)
          .setLabel('承認 (商品を送信)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`pay_reject_${transactionId}`)
          .setLabel('却下')
          .setStyle(ButtonStyle.Danger)
      );

      await paymentChannel.send({ embeds: [requestEmbed], components: [buttons] });
      return interaction.editReply({ content: '購入申請を送信しました。管理者がPayPayの支払いを確認次第、商品がDM宛てに送信されます。しばらくお待ちください。' });

    } catch (error) {
      console.error(error);
      return interaction.reply({ content: '申請の処理中にエラーが発生しました。', ephemeral: true }).catch(() => null);
    }
  }
}

module.exports = handleModalSubmit;
