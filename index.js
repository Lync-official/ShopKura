const dns = require('dns');
// Render等のIPv6環境がないサーバーでSupabaseへの接続エラー(ENETUNREACH)を防ぐため、IPv4を優先に設定
dns.setDefaultResultOrder('ipv4first');

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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
  MessageFlags,
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
    GatewayIntentBits.GuildMessages
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
      ALTER TABLE pending_transactions ADD COLUMN IF NOT EXISTS channel_id VARCHAR(255);
    `);
    await dbClient.query(`
      ALTER TABLE pending_transactions ADD COLUMN IF NOT EXISTS message_id VARCHAR(255);
    `);
    // PayPay送金リンクの使い回し（二重利用）を防ぐための恒久ログ。
    // pending_transactionsは承認/却下/期限切れのたびに削除されるため、リンク単位の履歴はこちらで保持する。
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS payment_links (
        paypay_url TEXT PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        transaction_id VARCHAR(255),
        user_id VARCHAR(255),
        product_id VARCHAR(255),
        created_at BIGINT NOT NULL,
        decided_at BIGINT
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
  console.log(`PayPayリンク検証: 入力URL=${url} / host=${new URL(url).hostname} / 抽出linkId=${linkId} / リクエストURL=${apiUrl}`);
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '(本文取得不可)');
      console.error(`PayPay APIリクエスト失敗: status=${response.status} ${response.statusText} / linkId=${linkId} / body=${bodyText.slice(0, 500)}`);
      return { valid: false, unverifiable: true, reason: `PayPayの自動検証APIに接続できませんでした。(status: ${response.status})` };
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
    return { valid: false, unverifiable: true, reason: 'PayPay検証処理中にエラーが発生しました（自動検証APIへの接続に問題がある可能性があります）。' };
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
      name: `${prod.name}${outOfStock ? ' 【売り切れ】' : ''}`,
      value: `価格: ${priceLabel}\n商品ID: ${prod.id} | 在庫: ${stockLabel}\n説明: ${prod.description}`
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

// 一定時間（PENDING_TRANSACTION_TIMEOUT_MS）が経過した購入申請を自動的に却下する。
// PayPay送金リンクの受け取り有効期限（48時間）切れを放置してpending_transactionsに溜まり続けるのを防ぐためのもの。
const PENDING_TRANSACTION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24時間

async function expireStalePendingTransactions() {
  const cutoff = Date.now() - PENDING_TRANSACTION_TIMEOUT_MS;

  let expiredRows;
  try {
    // created_at条件付きDELETEを直接使うことで、管理者が同時に承認/却下ボタンを押した場合との競合を避ける
    // （どちらのDELETEが先にコミットされてもレコードは一意に消費される）
    const res = await pool.query('DELETE FROM pending_transactions WHERE created_at < $1 RETURNING *', [cutoff]);
    expiredRows = res.rows;
  } catch (err) {
    console.error('期限切れ購入申請の取得中にエラー:', err);
    return;
  }

  if (expiredRows.length === 0) return;

  for (const tx of expiredRows) {
    try {
      await pool.query(
        "UPDATE payment_links SET status = 'expired', decided_at = $1 WHERE paypay_url = $2 AND status = 'pending'",
        [Date.now(), tx.paypay_url]
      );

      const buyer = await client.users.fetch(tx.user_id).catch(() => null);
      if (buyer) {
        const dmEmbed = new EmbedBuilder()
          .setTitle('購入申請 期限切れのお知らせ')
          .setDescription('一定時間が経過したため、購入申請は自動的に却下扱いとなりました。お手数ですが再度購入手続きを行ってください。')
          .setColor(0x808080)
          .setTimestamp();
        await buyer.send({ embeds: [dmEmbed] }).catch(() => null);
      }

      if (tx.channel_id && tx.message_id) {
        try {
          const channel = await client.channels.fetch(tx.channel_id);
          const message = await channel.messages.fetch(tx.message_id);
          const updatedEmbed = EmbedBuilder.from(message.embeds[0])
            .setColor(0x808080)
            .setTitle('購入申請 期限切れ（自動却下）');
          await message.edit({ embeds: [updatedEmbed], components: [] });
        } catch (err) {
          // メッセージが手動削除されている等は無視
        }
      }
    } catch (err) {
      console.error(`購入申請(${tx.id})の期限切れ処理中にエラー:`, err);
    }
  }

  console.log(`購入申請の期限切れ自動処理: ${expiredRows.length} 件を自動却下しました。`);
}

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName('vending-add')
    .setDescription('管理者用 新しい商品を追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('id').setDescription('商品ID').setRequired(true))
    .addStringOption(option => option.setName('vending_id').setDescription('自販機の名前（既存を選択するか新しい名前を入力して新規作成）').setRequired(true).setAutocomplete(true))
    .addStringOption(option => option.setName('name').setDescription('商品名').setRequired(true))
    .addIntegerOption(option => option.setName('price').setDescription('価格（円）').setRequired(true))
    .addStringOption(option => option.setName('description').setDescription('商品の説明').setRequired(true))
    .addBooleanOption(option => option.setName('infinite_stock').setDescription('在庫を∞（無限）にする場合はTrue。売り切れなしで購入し続けられます').setRequired(false)),

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
    .setDescription('指定した自販機の商品一覧を表示します')
    .addStringOption(option => option.setName('vending_id').setDescription('表示する自販機の名前').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('vending-setup')
    .setDescription('管理者用 このチャンネルに自販機パネルを設置します（名前ごとに別の商品を販売可能）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('vending_id').setDescription('設置する自販機の名前（既存を選択するか新しい名前を入力して新規作成）').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('vending-refresh-all')
    .setDescription('管理者用 設置済みの全自販機パネルを一斉に最新の状態へ更新します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

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
  
  // 許可されたサーバー以外のギルドから退出する
  const ALLOWED_GUILD_ID = '1528260161683062826';
  client.guilds.cache.forEach(async (guild) => {
    if (guild.id !== ALLOWED_GUILD_ID) {
      console.log(`許可されていないサーバー (${guild.name} / ID: ${guild.id}) から退出します。`);
      await guild.leave().catch(err => console.error('サーバー退出エラー:', err));
    }
  });

  // ログイン情報からアプリケーションID（クライアントID）を自動で取得
  const clientId = client.application.id;
  await registerCommands(clientId);

  // 期限切れの購入申請（PayPay送金リンクの受け取り期限切れ放置など）を自動で却下扱いにする
  await expireStalePendingTransactions().catch(err => console.error('期限切れ購入申請の初回処理エラー:', err));
  setInterval(() => {
    expireStalePendingTransactions().catch(err => console.error('期限切れ購入申請の定期処理エラー:', err));
  }, 30 * 60 * 1000); // 30分ごとにチェック
});

// 新しいサーバーに追加されたときの処理
client.on('guildCreate', async (guild) => {
  const ALLOWED_GUILD_ID = '1528260161683062826';
  if (guild.id !== ALLOWED_GUILD_ID) {
    console.log(`許可されていないサーバー (${guild.name} / ID: ${guild.id}) に追加されたため、即座に退出します。`);
    await guild.leave().catch(err => console.error('サーバー退出エラー:', err));
  }
});

client.on('interactionCreate', async interaction => {
  // 自販機名の入力補完（既存の自販機名を候補に出す。一致しなければ新しい名前として新規作成できる）
  if (interaction.isAutocomplete()) {
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
    return;
  }

  if (interaction.isChatInputCommand()) {
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
        return interaction.reply({ content: '商品の追加処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }

    // 2. vending-delete
    if (commandName === 'vending-delete') {
      const id = interaction.options.getString('id');

      try {
        const res = await pool.query('DELETE FROM products WHERE id = $1 RETURNING vending_id', [id]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: `商品ID: ${id} は存在しません。`, flags: MessageFlags.Ephemeral });
        }
        const deletedVendingId = res.rows[0].vending_id;
        return interaction.reply({ content: `商品ID: ${id} を削除しました。` }).then(() => refreshVendingPanels(deletedVendingId));
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '商品の削除中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }

    // 3. vending-stock
    if (commandName === 'vending-stock') {
      const id = interaction.options.getString('id');
      const itemsInput = interaction.options.getString('items');

      try {
        const res = await pool.query('SELECT name, vending_id, stock FROM products WHERE id = $1', [id]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: `商品ID: ${id} が見つかりません。先に vending-add で登録してください。`, flags: MessageFlags.Ephemeral });
        }

        const newItems = itemsInput.split(/,|\n/).map(item => item.trim()).filter(item => item.length > 0);
        const currentStock = res.rows[0].stock || [];
        const updatedStock = [...currentStock, ...newItems];
        const vendingId = res.rows[0].vending_id;

        await pool.query('UPDATE products SET stock = $1::text[] WHERE id = $2', [updatedStock, id]);

        const embed = new EmbedBuilder()
          .setTitle('在庫追加完了')
          .setColor(0x00AAFF)
          .setDescription(`商品 ${res.rows[0].name} (ID: ${id}) に ${newItems.length} 個の在庫を追加しました。`)
          .addFields({ name: '現在の総在庫数', value: `${updatedStock.length} 個` })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] }).then(() => refreshVendingPanels(vendingId));
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '在庫の追加中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: '自販機リストの読み込み中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: `自販機「${vendingId}」のパネルをこのチャンネルに設置しました。${noticeSuffix}`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '自販機パネルの設置中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }

    // 4.6 vending-refresh-all（管理者用 設置済みの全自販機パネルを一斉更新。購入方式やパネル表示を変更した際にまとめて反映するためのもの）
    if (commandName === 'vending-refresh-all') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
        return interaction.reply({ content: '設定の保存中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: '設定の保存中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }
  }

  // ボタンイベント
  if (interaction.isButton()) {
    const settings = await getSettings();

    // 自販機「購入する」ボタン：本人にしか見えない商品選択メニューを表示する
    if (interaction.customId.startsWith('vshop_open_')) {
      const vendingId = interaction.customId.replace('vshop_open_', '');

      try {
        const res = await pool.query('SELECT * FROM products WHERE vending_id = $1 ORDER BY name', [vendingId]);
        if (res.rowCount === 0) {
          return interaction.reply({ content: 'この自販機には現在商品が登録されていません。', flags: MessageFlags.Ephemeral });
        }

        // Discordのセレクトメニューは最大25件までしか選択肢を持てないため先頭25件に制限
        const options = res.rows.slice(0, 25).map(prod => {
          const outOfStock = !prod.infinite_stock && (!prod.stock || prod.stock.length === 0);
          const stockLabel = prod.infinite_stock ? '∞' : `${prod.stock ? prod.stock.length : 0}個`;
          const priceLabel = Number(prod.price) === 0 ? '無料' : `${prod.price}円`;

          return new StringSelectMenuOptionBuilder()
            .setLabel(`${prod.name}${outOfStock ? ' 【売り切れ】' : ''}`.slice(0, 100))
            .setValue(prod.id)
            .setDescription(`価格: ${priceLabel} ｜ 在庫: ${stockLabel}`.slice(0, 100));
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

        return interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error(err);
        return interaction.reply({ content: '商品選択メニューの表示中にエラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    }

    // チケット作成
    if (interaction.customId === 'ticket_create') {
      const guild = interaction.guild;
      const user = interaction.user;

      const existingChannel = guild.channels.cache.find(c => c.name === `ticket-${user.username.toLowerCase()}`);
      if (existingChannel) {
        return interaction.reply({ content: `既に作成済みのチケットチャンネルがあります: ${existingChannel}`, flags: MessageFlags.Ephemeral });
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

        await interaction.reply({ content: `チケットを作成しました: ${ticketChannel}`, flags: MessageFlags.Ephemeral });

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
        return interaction.reply({ content: 'チケットチャンネルの作成中にエラーが発生しました。ボットの権限を確認してください。', flags: MessageFlags.Ephemeral });
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
            await dbClient.query('UPDATE products SET stock = $1::text[] WHERE id = $2', [stock, prodId]);
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

        // 取引情報を削除（payment_linksの方はリンクの再利用防止のため削除せず状態だけ更新して残す）
        await dbClient.query('DELETE FROM pending_transactions WHERE id = $1', [transactionId]);
        await dbClient.query(
          "UPDATE payment_links SET status = $1, decided_at = $2 WHERE paypay_url = $3",
          [isApprove ? 'approved' : 'rejected', Date.now(), transactionData.paypay_url]
        );
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
        return interaction.followUp({ content: `処理に失敗しました: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => null);
      } finally {
        dbClient.release();
      }
    }
  }

  // セレクトメニューイベント（自販機の商品選択）
  if (interaction.isStringSelectMenu()) {
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
              await dbClient.query('UPDATE products SET stock = $1::text[] WHERE id = $2', [stock, prodId]);
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
        return interaction.reply({ content: '購入処理の開始中にエラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
    return;
  }

  // モーダル入力イベント
  if (interaction.isModalSubmit()) {
    const settings = await getSettings();

    // 実績報告モーダル
    if (interaction.customId === 'vouch_modal') {
      const vouchChannelId = settings.vouch_channel_id;

      if (!vouchChannelId) {
        return interaction.reply({ content: '実績報告を受け取るチャンネルが設定されていません。管理者が 実績受け取り コマンドを実行して設定してください。', flags: MessageFlags.Ephemeral });
      }

      const product = interaction.fields.getTextInputValue('vouch_product');
      const quantity = interaction.fields.getTextInputValue('vouch_quantity');
      const review = interaction.fields.getTextInputValue('vouch_review');
      const ratingVal = interaction.fields.getTextInputValue('vouch_rating');

      const vouchChannel = interaction.guild.channels.cache.get(vouchChannelId);
      if (!vouchChannel) {
        return interaction.reply({ content: '設定された実績受け取りチャンネルが見つかりませんでした。再度 実績受け取り コマンドで設定し直してください。', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: '実績を報告しました。ご協力ありがとうございました。', flags: MessageFlags.Ephemeral });
      } catch (error) {
        console.error('実績送信エラー:', error);
        return interaction.reply({ content: '実績の送信中にエラーが発生しました。ボットの権限を確認してください。', flags: MessageFlags.Ephemeral });
      }
    }

    // PayPay送金リンク決済モーダル
    if (interaction.customId.startsWith('pay_modal_')) {
      const prodId = interaction.customId.replace('pay_modal_', '');
      const paypayUrl = interaction.fields.getTextInputValue('paypay_url');

      try {
        const prodRes = await pool.query('SELECT * FROM products WHERE id = $1', [prodId]);
        if (prodRes.rowCount === 0) {
          return interaction.reply({ content: 'この商品は存在しないか、既に削除されています。', flags: MessageFlags.Ephemeral });
        }

        const prod = prodRes.rows[0];

        const paymentChannel = interaction.guild.channels.cache.get(settings.payment_channel_id);
        if (!paymentChannel) {
          return interaction.reply({ content: '決済確認チャンネルが見つかりません。管理者に確認してください。', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // PayPay自動検証
        const validation = await verifyPayPayLink(paypayUrl, prod.price);
        // linkの形式不正・金額不一致・使用済みなど「明確に無効」な場合のみブロックする。
        // API自体に接続できない（unverifiable）場合は自動検証を諦めて、管理者の手動確認に委ねる。
        if (!validation.valid && !validation.unverifiable) {
          return interaction.editReply({ content: `申請を送信できませんでした: ${validation.reason}` });
        }

        const transactionId = `tx_${Date.now()}_${interaction.user.id}`;

        // 送金リンクの二重使用防止：同じpaypay_urlが既に処理中/承認済み/却下済み/期限切れであれば申請自体をブロックする。
        // INSERT ... ON CONFLICT DO NOTHINGで原子的に「予約」するため、同時押しでも競合しない。
        const linkClaim = await pool.query(
          `INSERT INTO payment_links (paypay_url, status, transaction_id, user_id, product_id, created_at)
           VALUES ($1, 'pending', $2, $3, $4, $5)
           ON CONFLICT (paypay_url) DO NOTHING
           RETURNING paypay_url`,
          [paypayUrl, transactionId, interaction.user.id, prodId, Date.now()]
        );

        if (linkClaim.rowCount === 0) {
          const existing = await pool.query('SELECT status FROM payment_links WHERE paypay_url = $1', [paypayUrl]);
          const status = existing.rows[0]?.status;
          const reasonMap = {
            pending: 'このPayPay送金リンクは既に別の申請で処理中です。管理者の確認をお待ちください。',
            approved: 'このPayPay送金リンクは既に使用（承認）済みです。',
            rejected: 'このPayPay送金リンクは過去に却下されています。別の送金リンクをご用意ください。',
            expired: 'このPayPay送金リンクは期限切れとして処理済みです。別の送金リンクをご用意ください。'
          };
          return interaction.editReply({ content: `申請を送信できませんでした: ${reasonMap[status] || 'このPayPay送金リンクは既に使用されています。'}` });
        }

        // トランザクション情報を保存
        await pool.query(`
          INSERT INTO pending_transactions (id, user_id, product_id, paypay_url, created_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [transactionId, interaction.user.id, prodId, paypayUrl, Date.now()]);

        const requestEmbed = new EmbedBuilder()
          .setTitle(validation.unverifiable ? '購入申請 (PayPay支払い) ⚠️自動検証不可' : '購入申請 (PayPay支払い)')
          .setColor(validation.unverifiable ? 0xE67E22 : 0xF39C12)
          .addFields(
            { name: '購入者', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
            { name: '商品名', value: prod.name, inline: true },
            { name: '価格', value: `${prod.price} 円`, inline: true },
            { name: 'PayPay送金リンク', value: paypayUrl }
          )
          .setTimestamp();

        if (validation.unverifiable) {
          requestEmbed.addFields({
            name: '⚠️ 注意',
            value: `PayPayの自動検証に失敗したため、金額・状態の自動チェックができていません（${validation.reason}）。承認前に必ず送金リンクの内容とスクリーンショット等をご自身で確認してください。`
          });
        }

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

        const sentRequestMsg = await paymentChannel.send({ embeds: [requestEmbed], components: [buttons] });
        await pool.query(
          'UPDATE pending_transactions SET channel_id = $1, message_id = $2 WHERE id = $3',
          [paymentChannel.id, sentRequestMsg.id, transactionId]
        );

        const replyMsg = validation.unverifiable
          ? '購入申請を送信しました（今回は自動検証ができなかったため、管理者による手動確認となります）。しばらくお待ちください。'
          : '購入申請を送信しました。管理者がPayPayの支払いを確認次第、商品がDM宛てに送信されます。しばらくお待ちください。';
        return interaction.editReply({ content: replyMsg });

      } catch (error) {
        console.error(error);
        return interaction.reply({ content: '申請の処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }
});

client.on('error', error => console.error('Discord Client Error:', error));
process.on('unhandledRejection', error => console.error('Unhandled Promise Rejection:', error));

// Renderデプロイ用の簡易ステータスWebサーバー
const http = require('http');
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShopKura Bot Status</title>
    <style>
        body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            background-color: #0f0f15;
            color: #e0e0e6;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: #161622;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }
        h1 {
            color: #8A2BE2;
            margin-bottom: 10px;
        }
        p {
            font-size: 1.1em;
            color: #a0a0b0;
        }
        .status {
            display: inline-block;
            padding: 8px 16px;
            background-color: #00FF88;
            color: #0f0f15;
            border-radius: 4px;
            font-weight: bold;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ShopKura</h1>
        <p>Discord Bot is active</p>
        <span class="status">ONLINE</span>
    </div>
</body>
</html>
`;

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
}).listen(port, () => {
  console.log(`Webサーバーがポート ${port} で起動しました。`);
});

const token = process.env.DISCORD_TOKEN;
if (token && !token.includes('YOUR_DISCORD')) {
  client.login(token);
} else {
  console.log('ボットを起動するには、.envファイルに DISCORD_TOKEN を設定してください。');
}
