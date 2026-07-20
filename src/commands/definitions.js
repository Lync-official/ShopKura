const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('verify-setup')
    .setDescription('管理者用 このチャンネルに認証パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('verify-lockdown')
    .setDescription('管理者用 認証チャンネル以外の全チャンネルを「認証ロール保持者のみ閲覧可」に一括設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('verify-pull')
    .setDescription('管理者用 データベースに保存されたユーザーをチェックし、脱退しているメンバーを再追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

module.exports = commands;
