const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
const client = require('../client');
const pool = require('../db/pool');
const { refreshVendingPanels } = require('../services/vendingService');
const { verifyMember } = require('../services/authService');

async function handleButton(interaction) {
  // 自販機「購入する」ボタン：本人にしか見えない商品選択メニューを表示する
  if (interaction.customId.startsWith('vshop_open_')) {
    const vendingId = interaction.customId.replace('vshop_open_', '');

    try {
      const res = await pool.query('SELECT * FROM products WHERE vending_id = $1 ORDER BY name', [vendingId]);
      if (res.rowCount === 0) {
        return interaction.reply({ content: 'この自販機には現在商品が登録されていません。', ephemeral: true });
      }

      // Discordのセレクトメニューは最大25件までしか選択肢を持てないため先頭25件に制限
      const options = res.rows.slice(0, 25).map(prod => {
        const outOfStock = !prod.infinite_stock && (!prod.stock || prod.stock.length === 0);
        const stockLabel = prod.infinite_stock ? '∞' : `${prod.stock ? prod.stock.length : 0}個`;
        const priceLabel = Number(prod.price) === 0 ? '無料' : `${prod.price}円`;

        return new StringSelectMenuOptionBuilder()
          .setLabel(`${prod.name} (${priceLabel})`.slice(0, 100))
          .setValue(prod.id)
          .setDescription(`${outOfStock ? '【売り切れ】 ' : ''}在庫: ${stockLabel}`.slice(0, 100));
      });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`vshop_select_${vendingId}`)
        .setPlaceholder('購入したい商品を選択してください')
        .addOptions(options);

      const selectRow = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(`自販機「${vendingId}」 商品選択`)
        .setDescription('購入したい商品を下のメニューから選択してください。この内容はあなたにしか表示されていません。')
        .setColor(0x8A2BE2);

      return interaction.reply({ embeds: [embed], components: [selectRow], ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '商品選択メニューの表示中にエラーが発生しました。', ephemeral: true });
    }
  }

  // チケット作成
  if (interaction.customId === 'ticket_create') {
    const guild = interaction.guild;
    const user = interaction.user;

    const existingChannel = guild.channels.cache.find(c => c.name === `ticket-${user.username.toLowerCase()}`);
    if (existingChannel) {
      return interaction.reply({ content: `既に作成済みのチケットチャンネルがあります: ${existingChannel}`, ephemeral: true });
    }

    try {
      const ticketChannel = await guild.channels.create({
        name: `ticket-${user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          }
        ]
      });

      await interaction.reply({ content: `チケットを作成しました: ${ticketChannel}`, ephemeral: true });

      const welcomeEmbed = new EmbedBuilder()
        .setTitle('サポートへようこそ')
        .setDescription(`${user} さん、お問い合わせ内容を入力してお待ちください。スタッフが対応いたします。用件が済んだら、下の「チケットを閉じる」ボタンを押してください。`)
        .setColor(0x1ABC9C)
        .setTimestamp();

      const closeBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('チケットを閉じる')
          .setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({ content: `${user} 様`, embeds: [welcomeEmbed], components: [closeBtn] });

    } catch (error) {
      console.error('チケット作成エラー:', error);
      return interaction.reply({ content: 'チケットチャンネルの作成中にエラーが発生しました。ボットの権限を確認してください。', ephemeral: true });
    }
  }

  // チケット削除
  if (interaction.customId === 'ticket_close') {
    await interaction.reply({ content: 'このチケットは5秒後に削除されます。' });
    setTimeout(async () => {
      try {
        await interaction.channel.delete();
      } catch (error) {
        console.error('チケット削除エラー:', error);
      }
    }, 5000);
  }

  // 実績報告ボタン
  if (interaction.customId === 'vouch_report_btn') {
    const modal = new ModalBuilder()
      .setCustomId('vouch_modal')
      .setTitle('実績を報告する');

    const productInput = new TextInputBuilder()
      .setCustomId('vouch_product')
      .setLabel('商品名')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('例: テスト商品')
      .setRequired(true);

    const quantityInput = new TextInputBuilder()
      .setCustomId('vouch_quantity')
      .setLabel('個数')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('例: 1個')
      .setRequired(true);

    const reviewInput = new TextInputBuilder()
      .setCustomId('vouch_review')
      .setLabel('感想メッセージ')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('例: 迅速な対応でした。また利用します。')
      .setRequired(true);

    const ratingInput = new TextInputBuilder()
      .setCustomId('vouch_rating')
      .setLabel('評価 (1から5の数値)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('例: 5')
      .setMaxLength(1)
      .setRequired(true);

    const row1 = new ActionRowBuilder().addComponents(productInput);
    const row2 = new ActionRowBuilder().addComponents(quantityInput);
    const row3 = new ActionRowBuilder().addComponents(reviewInput);
    const row4 = new ActionRowBuilder().addComponents(ratingInput);

    modal.addComponents(row1, row2, row3, row4);

    await interaction.showModal(modal);
  }



  // 決済の承認・却下処理
  if (interaction.customId.startsWith('pay_approve_') || interaction.customId.startsWith('pay_reject_')) {
    const isApprove = interaction.customId.startsWith('pay_approve_');
    const transactionId = interaction.customId.replace(isApprove ? 'pay_approve_' : 'pay_reject_', '');

    // 先に応答を保留してタイムアウトを防ぐ
    await interaction.deferUpdate();

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // 取引データを取得してロック
      const txRes = await dbClient.query('SELECT * FROM pending_transactions WHERE id = $1 FOR UPDATE', [transactionId]);
      if (txRes.rowCount === 0) {
        throw new Error('取引情報がすでに処理されたか、見つかりません。');
      }

      const transactionData = txRes.rows[0];
      const buyerId = transactionData.user_id;
      const prodId = transactionData.product_id;

      const buyer = await client.users.fetch(buyerId).catch(() => null);

      if (isApprove) {
        // 商品を取得して在庫ロック
        const prodRes = await dbClient.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [prodId]);
        if (prodRes.rowCount === 0) {
          throw new Error('商品が存在しません。');
        }

        const prod = prodRes.rows[0];
        let purchasedItem;

        if (prod.infinite_stock) {
          // 在庫∞商品：在庫配列は消費せず、テンプレートとして使い回す（vending-stockで登録した内容を毎回送信）
          purchasedItem = (prod.stock && prod.stock.length > 0) ? prod.stock[0] : '(配布データ未登録。管理者に問い合わせてください)';
        } else {
          if (!prod.stock || prod.stock.length === 0) {
            throw new Error('商品の在庫がありません。');
          }
          const stock = [...prod.stock];
          purchasedItem = stock.shift();

          // 在庫の更新（在庫∞商品は更新不要なので通常商品のみ）
          await dbClient.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, prodId]);
        }

        // DM送信処理
        if (buyer) {
          const dmEmbed = new EmbedBuilder()
            .setTitle('ご購入ありがとうございます')
            .setDescription(`${prodId} の購入申請が承認されました。以下が商品データです。`)
            .setColor(0x8A2BE2)
            .addFields(
              { name: '購入商品ID', value: prodId, inline: true },
              { name: '商品データ', value: `\`\`\`${purchasedItem}\`\`\`` }
            )
            .setTimestamp();

          await buyer.send({ embeds: [dmEmbed] }).catch(async (err) => {
            console.error('DM送信エラー:', err);
            throw new Error('ユーザーへのDM送信に失敗しました。');
          });
        }
      } else {
        // 却下時のDM通知
        if (buyer) {
          const dmEmbed = new EmbedBuilder()
            .setTitle('購入申請 却下のお知らせ')
            .setDescription(`申し訳ありません。商品の購入申請は管理者により却下されました。`)
            .setColor(0xFF0000)
            .setTimestamp();

          await buyer.send({ embeds: [dmEmbed] }).catch(() => null);
        }
      }

      // 取引情報を削除
      await dbClient.query('DELETE FROM pending_transactions WHERE id = $1', [transactionId]);
      await dbClient.query('COMMIT');

      // 在庫が変動した場合、この自販機IDの全設置パネルを自動更新する
      if (isApprove) {
        const affectedVendingId = (await pool.query('SELECT vending_id FROM products WHERE id = $1', [prodId])).rows[0]?.vending_id;
        await refreshVendingPanels(affectedVendingId);
      }

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(isApprove ? 0x00FF88 : 0xFF0000)
        .setTitle(isApprove ? '購入申請 承認済み' : '購入申請 却下済み');

      await interaction.editReply({ embeds: [updatedEmbed], components: [] });

    } catch (error) {
      await dbClient.query('ROLLBACK');
      console.error('承認/却下処理エラー:', error);
      return interaction.followUp({ content: `処理に失敗しました: ${error.message}`, ephemeral: true }).catch(() => null);
    } finally {
      dbClient.release();
    }
  }
}

module.exports = handleButton;
