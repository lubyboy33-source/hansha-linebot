// 訊息解析：抓手機號碼與「驗證碼」關鍵字（純函式，方便測試）

const KEYWORD_RE = /驗[證証]碼|验证码|認證碼|认证码|收不到簡訊|收不到简讯|OTP/i;

function normalize(text) {
  // NFKC：全形數字/符號轉半形（０９１２ → 0912、－ → -、＋ → +）
  return text.normalize('NFKC');
}

function extractPhones(text) {
  const cleaned = normalize(text)
    .replace(/[\s\-\(\)\.\,\/‧・·—–_]/g, '')
    .replace(/\+?886(?=9\d{8})/g, '0'); // +886912345678 / 886912345678 → 0912345678
  const matches = cleaned.match(/09\d{8}/g) || [];
  return [...new Set(matches)].slice(0, 3);
}

function hasKeyword(text) {
  return KEYWORD_RE.test(normalize(text));
}

module.exports = { extractPhones, hasKeyword };
