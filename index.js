const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// Supabase (PostgreSQL) の接続プール
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Supabase接続用
  }
});

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

// PayPay送金リンク自動検証関数
async function verifyPayPayLink(url, expectedAmount) {
  let linkId = '';
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

    if (host === 'paypay.ne.jp' && pathParts[0] === 'qr') {
      linkId = pathParts[1];
    } else if (host === 'pay.paypay.ne.jp') {
      linkId = pathParts[0];
    } else {
      return { valid: false, reason: 'PayPayの送金リンクではありません。' };
    }
  } catch (e) {
    return { valid: false, reason: '無効なURL形式です。' };
  }

  if (!linkId) {
    return { valid: false, reason: 'PayPayリンクIDを抽出できませんでした。' };
  }

  const apiUrl = `https://www.paypay.ne.jp/portal/api/v1/order/link/info?linkId=${linkId}`;
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return { valid: false, reason: 'PayPayのAPIリクエストが失敗しました。' };
    }

    const json = await response.json();
    if (json.resultInfo?.code !== 'SUCCESS') {
      return { valid: false, reason: '無効なPayPay送金リンクです。存在しないか期限切れの可能性があります。' };
    }

    const data = json.data;
    if (!data) {
      return { valid: false, reason: 'PayPayのデータが見つかりません。' };
    }

    const amount = data.amount;
    const orderStatus = data.orderStatus || data.chatRoomStatus;

    if (orderStatus !== 'PENDING') {
      return { valid: false, reason: `このリンクはすでに受け取り済みか、無効な状態です。ステータス: ${orderStatus}` };
    }

    if (Number(amount) !== Number(expectedAmount)) {
      return { valid: false, reason: `設定された金額（${amount}円）が商品の価格（${expectedAmount}円）と一致しません。` };
    }

    return { valid: true, amount };
  } catch (error) {
    console.error('PayPay検証エラー:', error);
    return { valid: false, reason: 'PayPay検証処理中にエラーが発生しました。' };
  }
}

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

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName('vending-add')
    .setDescription('管理者用 新しい商品を追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('id').setDescription('商品ID').setRequired(true))
    .addStringOption(option => option.setName('vending_id').setDescription('自販機ID（複数の自販機を分ける用）').setRequired(true))
    .addStringOption(option => option.setName('name').setDescription('商品名').setRequired(true))
    .addIntegerOption(option => option.setName('price').setDescription('価格（円）').setRequired(true))
    .addStringOption(option => option.setName('description').setDescription('商品の説明').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vending-delete')
    .setDescription('管理者用 商品を削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('id').setDescription('削除する商品ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vending-stock')
    .setDescription('管理者用 商品の在庫を追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('id').setDescription('対象の商品ID').setRequired(true))
    .addStringOption(option => option.setName('items').setDescription('追加するアイテムデータ（カンマまたは改行区切り）').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vending-list')
    .setDescription('指定した自販機IDの商品一覧を表示します')
    .addStringOption(option => option.setName('vending_id').setDescription('表示する自販機ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('管理者用 チケット作成パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('vouch-setup')
    .setDescription('管理者用 実績報告パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('実績受け取り')
    .setDescription('このチャンネルを実績報告の受け取りチャンネルに設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('決済確認チャンネル')
    .setDescription('管理者用 PayPay決済の承認リクエストを受け取るチャンネルに設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

async function registerCommands(clientId) {
  const token = process.env.DISCORD_TOKEN;

  if (!token || token.includes('YOUR_DISCORD')) {
    console.warn('警告: DISCORD_TOKEN が設定されていません。');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('アプリケーションコマンドの再登録を開始します...');
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
    console.log('アプリケーションコマンドの登録に成功しました。');
  } catch (error) {
    console.error('コマンド登録中にエラーが発生しました:', error);
  }
}

client.once('ready', async () => {
  console.log(`ログインしました: ${client.user.tag}`);
  await initDb();
  
  // ログイン情報からアプリケーションID（クライアントID）を自動で取得
  const clientId = client.application.id;
  await registerCommands(clientId);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // 1. vending-add
    if (commandName === 'vending-add') {
      const id = interaction.options.getString('id');
      const vendingId = interaction.options.getString('vending_id');
      const name = interaction.options.getString('name');
      const price = interaction.options.getInteger('price');
      const description = interaction.options.getString('description');

      try {
        await pool.query(`
          INSERT INTO products (id, vending_id, name, price, description, stock)
          VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT stock FROM products WHERE id = $1), '{}'::text[]))
          ON CONFLICT (id) DO UPDATE 
          SET vending_id = EXCLUDED.vending_id, name = EXCLUDED.name, price = EXCLUDED.price, description = EXCLUDED.description;
        `, [id, vendingId, name, price, description]);

        const embed = new EmbedBuilder()
          .setTitle('商品の追加または更新完了')
          .setColor(0x00FF88)
          .addFields(
            { name: '商品ID', value: id, inline: true },
            { name: '自販機ID', value: vendingId, inline: true },
            { name: '商品名', value: name, inline: true },
            { name: '価格', value: `${price} 円`, inline: true },
            { name: '説明', value: description }
          )
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '商品の追加処理中にエラーが発生しました。', ephemeral: true });
      }
    }

    // 2. vending-delete
    if (commandName === 'vending-delete') {
      const id = interaction.options.getString('id');

      try {
        const res = await pool.query('DELETE FROM products WHERE id = $1', [id]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: `商品ID: ${id} は存在しません。`, ephemeral: true });
        }
        return interaction.reply({ content: `商品ID: ${id} を削除しました。` });
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
        const res = await pool.query('SELECT name, stock FROM products WHERE id = $1', [id]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: `商品ID: ${id} が見つかりません。先に vending-add で登録してください。`, ephemeral: true });
        }

        const newItems = itemsInput.split(/,|\n/).map(item => item.trim()).filter(item => item.length > 0);
        const currentStock = res.rows[0].stock || [];
        const updatedStock = [...currentStock, ...newItems];

        await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [updatedStock, id]);

        const embed = new EmbedBuilder()
          .setTitle('在庫追加完了')
          .setColor(0x00AAFF)
          .setDescription(`商品 ${res.rows[0].name} (ID: ${id}) に ${newItems.length} 個の在庫を追加しました。`)
          .addFields({ name: '現在の総在庫数', value: `${updatedStock.length} 個` })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '在庫の追加中にエラーが発生しました。', ephemeral: true });
      }
    }

    // 4. vending-list
    if (commandName === 'vending-list') {
      const vendingId = interaction.options.getString('vending_id');

      try {
        const res = await pool.query('SELECT * FROM products WHERE vending_id = $1', [vendingId]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: `自販機ID: ${vendingId} に登録されている商品は現在ありません。`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle(`ShopKura オンライン自販機 (自販機ID: ${vendingId})`)
          .setDescription('購入したい商品の購入ボタンを押してください。お支払いはPayPay送金リンクのみ受け付けております。')
          .setColor(0x8A2BE2)
          .setTimestamp();

        const rows = [];
        let currentRow = new ActionRowBuilder();

        res.rows.forEach((prod, index) => {
          embed.addFields({
            name: `${prod.name} (${prod.price} 円)`,
            value: `商品ID: ${prod.id} | 在庫: ${prod.stock ? prod.stock.length : 0} 個\n説明: ${prod.description}`
          });

          const btn = new ButtonBuilder()
            .setCustomId(`buy_${prod.id}`)
            .setLabel(`購入: ${prod.name}`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!prod.stock || prod.stock.length === 0);

          currentRow.addComponents(btn);

          if ((index + 1) % 5 === 0 || index === res.rowCount - 1) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
          }
        });

        return interaction.reply({ embeds: [embed], components: rows });
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '自販機リストの読み込み中にエラーが発生しました。', ephemeral: true });
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
  }

  // ボタンイベント
  if (interaction.isButton()) {
    const settings = await getSettings();

    // 自販機購入ボタン
    if (interaction.customId.startsWith('buy_')) {
      const prodId = interaction.customId.replace('buy_', '');

      try {
        const res = await pool.query('SELECT * FROM products WHERE id = $1', [prodId]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: 'この商品は存在しないか、既に削除されています。', ephemeral: true });
        }

        const prod = res.rows[0];
        if (!prod.stock || prod.stock.length === 0) {
          return interaction.reply({ content: `${prod.name} は売り切れです。`, ephemeral: true });
        }

        if (!settings.payment_channel_id) {
          return interaction.reply({ content: '管理者が決済確認チャンネルを設定していないため、購入手続きを開始できません。', ephemeral: true });
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

        const row = new ActionRowBuilder().addComponents(urlInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '購入処理の開始中にエラーが発生しました。', ephemeral: true });
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
          if (!prod.stock || prod.stock.length === 0) {
            throw new Error('商品の在庫がありません。');
          }

          const stock = [...prod.stock];
          const purchasedItem = stock.shift();

          // 在庫の更新
          await dbClient.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, prodId]);

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

  // モーダル入力イベント
  if (interaction.isModalSubmit()) {
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
});

client.on('error', error => console.error('Discord Client Error:', error));
process.on('unhandledRejection', error => console.error('Unhandled Promise Rejection:', error));

const token = process.env.DISCORD_TOKEN;
if (token && !token.includes('YOUR_DISCORD')) {
  client.login(token);
} else {
  console.log('ボットを起動するには、.envファイルに DISCORD_TOKEN と CLIENT_ID を設定してください。');
}
