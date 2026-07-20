const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pool = require('../db/pool');
const config = require('../config');
const { buildVendingPanel, refreshVendingPanels, refreshAllVendingPanels } = require('../services/vendingService');
const { lockdownGuildChannels } = require('../services/authService');

async function handleChatInputCommand(interaction) {
  const { commandName } = interaction;

  // 1. vending-add
  if (commandName === 'vending-add') {
    const id = interaction.options.getString('id');
    const vendingId = interaction.options.getString('vending_id');
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const description = interaction.options.getString('description');
    const infiniteStock = interaction.options.getBoolean('infinite_stock') ?? false;

    try {
      await pool.query(`
        INSERT INTO products (id, vending_id, name, price, description, stock, infinite_stock)
        VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT stock FROM products WHERE id = $7), '{}'::text[]), $6)
        ON CONFLICT (id) DO UPDATE 
        SET vending_id = EXCLUDED.vending_id, name = EXCLUDED.name, price = EXCLUDED.price, description = EXCLUDED.description, infinite_stock = EXCLUDED.infinite_stock;
      `, [id, vendingId, name, price, description, infiniteStock, id]);

      const embed = new EmbedBuilder()
        .setTitle('商品の追加または更新完了')
        .setColor(0x00FF88)
        .addFields(
          { name: '商品ID', value: id, inline: true },
          { name: '自販機名', value: vendingId, inline: true },
          { name: '商品名', value: name, inline: true },
          { name: '価格', value: price === 0 ? '無料' : `${price} 円`, inline: true },
          { name: '在庫設定', value: infiniteStock ? '∞（無限）' : '通常（個数管理）', inline: true },
          { name: '説明', value: description }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] }).then(() => refreshVendingPanels(vendingId));
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '商品の追加処理中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 2. vending-delete
  if (commandName === 'vending-delete') {
    const id = interaction.options.getString('id');

    try {
      const res = await pool.query('DELETE FROM products WHERE id = $1 RETURNING vending_id', [id]);
      if (res.rowCount === 0) {
        return interaction.reply({ content: `商品ID: ${id} は存在しません。`, ephemeral: true });
      }
      const deletedVendingId = res.rows[0].vending_id;
      return interaction.reply({ content: `商品ID: ${id} を削除しました。` }).then(() => refreshVendingPanels(deletedVendingId));
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '商品の削除中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 3. vending-stock
  if (commandName === 'vending-stock') {
    const id = interaction.options.getString('id');
    const itemsInput = interaction.options.getString('items');

    try {
      const res = await pool.query('SELECT name, vending_id, stock FROM products WHERE id = $1', [id]);
      if (res.rowCount === 0) {
        return interaction.reply({ content: `商品ID: ${id} が見つかりません。先に vending-add で登録してください。`, ephemeral: true });
      }

      const newItems = itemsInput.split(/,|\n/).map(item => item.trim()).filter(item => item.length > 0);
      const currentStock = res.rows[0].stock || [];
      const updatedStock = [...currentStock, ...newItems];
      const vendingId = res.rows[0].vending_id;

      await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [updatedStock, id]);

      const embed = new EmbedBuilder()
        .setTitle('在庫追加完了')
        .setColor(0x00AAFF)
        .setDescription(`商品 ${res.rows[0].name} (ID: ${id}) に ${newItems.length} 個の在庫を追加しました。`)
        .addFields({ name: '現在の総在庫数', value: `${updatedStock.length} 個` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] }).then(() => refreshVendingPanels(vendingId));
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '在庫の追加中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 4. vending-list
  if (commandName === 'vending-list') {
    const vendingId = interaction.options.getString('vending_id');

    try {
      const panel = await buildVendingPanel(vendingId);
      return interaction.reply({ embeds: [panel.embed], components: panel.rows });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '自販機リストの読み込み中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 4.5 vending-setup（管理者用 自販機パネルの設置。名前ごと・複数チャンネルに設置可能。新しい名前を入力すれば新規の自販機として作成される）
  if (commandName === 'vending-setup') {
    const vendingId = interaction.options.getString('vending_id');

    try {
      const panel = await buildVendingPanel(vendingId);
      const sentMessage = await interaction.channel.send({ embeds: [panel.embed], components: panel.rows });

      // 設置場所をDBに記録し、以後この自販機名の商品が変わるたびに自動でこのメッセージも更新する
      await pool.query(
        'INSERT INTO vending_panels (message_id, channel_id, vending_id) VALUES ($1, $2, $3)',
        [sentMessage.id, interaction.channelId, vendingId]
      );

      const noticeSuffix = panel.isEmpty ? '（現在商品は未登録です。vending-add で商品を追加すると自動的に反映されます）' : '';
      return interaction.reply({ content: `自販機「${vendingId}」のパネルをこのチャンネルに設置しました。${noticeSuffix}`, ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '自販機パネルの設置中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 4.6 vending-refresh-all（管理者用 設置済みの全自販機パネルを一斉更新。購入方式やパネル表示を変更した際にまとめて反映するためのもの）
  if (commandName === 'vending-refresh-all') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await refreshAllVendingPanels();

      const embed = new EmbedBuilder()
        .setTitle('全自販機パネル 一斉更新完了')
        .setColor(0x00FF88)
        .addFields(
          { name: '対象自販機数', value: `${result.vendingCount} 個`, inline: true },
          { name: '更新成功', value: `${result.success} 件`, inline: true },
          { name: '更新失敗（削除済みなど）', value: `${result.failed} 件`, inline: true }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('全自販機パネル一斉更新エラー:', err);
      return interaction.editReply({ content: '一斉更新の処理中にエラーが発生しました。' });
    }
  }

  // 5. ticket-setup
  if (commandName === 'ticket-setup') {
    const embed = new EmbedBuilder()
      .setTitle('サポートチケット窓口')
      .setDescription('お問い合わせ、ご質問、サポートが必要な場合は下のボタンを押してください。専用のプライベートチャンネルが作成されます。')
      .setColor(0x1ABC9C);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_create')
        .setLabel('チケットを作成する')
        .setStyle(ButtonStyle.Success)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // 6. vouch-setup
  if (commandName === 'vouch-setup') {
    const embed = new EmbedBuilder()
      .setTitle('実績の報告')
      .setDescription('当ショップをご利用いただきありがとうございます。下の「実績を報告」ボタンをクリックし、感想や評価を送信してください。')
      .setColor(0xF39C12);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vouch_report_btn')
        .setLabel('実績を報告')
        .setStyle(ButtonStyle.Primary)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // 7. 実績受け取り
  if (commandName === '実績受け取り') {
    try {
      await pool.query("UPDATE settings SET vouch_channel_id = $1 WHERE key = 'guildSettings'", [interaction.channelId]);

      const embed = new EmbedBuilder()
        .setTitle('実績受け取りチャンネル設定完了')
        .setDescription(`このチャンネルが実績報告の送信先に設定されました。`)
        .setColor(0x2ECC71)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '設定の保存中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 8. 決済確認チャンネル
  if (commandName === '決済確認チャンネル') {
    try {
      await pool.query("UPDATE settings SET payment_channel_id = $1 WHERE key = 'guildSettings'", [interaction.channelId]);

      const embed = new EmbedBuilder()
        .setTitle('決済確認チャンネル設定完了')
        .setDescription(`このチャンネルがPayPay決済承認リクエストの受け取り先に設定されました。`)
        .setColor(0x2ECC71)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '設定の保存中にエラーが発生しました。', ephemeral: true });
    }
  }

  // 9. verify-setup（管理者用 認証パネルの設置。ボタンを押すとその場で認証ロールが付与される）
  if (commandName === 'verify-setup') {
    const embed = new EmbedBuilder()
      .setTitle('サーバー認証')
      .setDescription('下の「認証する」ボタンを押すと認証が完了し、サーバー内の各チャンネルが閲覧できるようになります。')
      .setColor(0x5865F2)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('verify_button')
        .setLabel('認証する')
        .setStyle(ButtonStyle.Success)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // 10. verify-lockdown（管理者用 認証チャンネル以外の全チャンネルを認証制に一括設定）
  if (commandName === 'verify-lockdown') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await lockdownGuildChannels(interaction.guild);

      const embed = new EmbedBuilder()
        .setTitle('チャンネル閲覧権限 一括設定完了')
        .setColor(0x00FF88)
        .setDescription(`認証チャンネル（<#${config.VERIFY_CHANNEL_ID}>）以外は、認証ロール（<@&${config.VERIFIED_ROLE_ID}>）を持つメンバーのみ閲覧できるように設定しました。`)
        .addFields(
          { name: '設定成功', value: `${result.updated} チャンネル`, inline: true },
          { name: 'スキップ（チケット/除外設定）', value: `${result.skipped} チャンネル`, inline: true },
          { name: '設定失敗', value: `${result.failed} チャンネル`, inline: true }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('チャンネル権限一括設定エラー:', err);
      return interaction.editReply({ content: '権限の一括設定中にエラーが発生しました。ボットのロール順位が認証ロールより上にあるか、チャンネル管理権限があるか確認してください。' });
    }
  }
}

module.exports = handleChatInputCommand;
