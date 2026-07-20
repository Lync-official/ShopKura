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

module.exports = { verifyPayPayLink };
