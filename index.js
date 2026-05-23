const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { chromium } = require('playwright');

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const app = express();

const BASE_URL = 'https://d34k8i6r6n78f2.cloudfront.net';
const LOGIN_URL = `${BASE_URL}/home/login`;
const SEND_CODE_URL = `${BASE_URL}/system/SendLoginCode`;

async function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function doLogin(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'load' });
  await page.fill('input[placeholder="account"]', process.env.HANSHA_USERNAME);
  await page.fill('input[placeholder="password"]', process.env.HANSHA_PASSWORD);
  await page.press('input[placeholder="password"]', 'Enter');
  // Wait for login redirect to complete (site may redirect through home page)
  await page.waitForTimeout(5000);
  console.log('登入後 URL:', page.url());
}

async function sendCodes(phone) {
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // 導向發送驗證碼頁面，若被跳轉到登入頁則先登入
    await page.goto(SEND_CODE_URL, { waitUntil: 'load' });
    if (page.url().includes('/login') || page.url().includes('/Login')) {
      await doLogin(page);
      await page.goto(SEND_CODE_URL, { waitUntil: 'load' });
    }

    // APP登入 (Scenario 1) - click label because it intercepts the radio button
    await page.click('label[for="ra1"]');
    await page.fill('input.form-control.col-md-3', phone);
    await page.click('input[type="button"].btn-primary');
    await page.waitForTimeout(2000);
    console.log(`已發送 APP登入 驗證碼給 ${phone}`);

    // 場景登入 (Scenario 2) - 重新載入頁面以重置表單
    await page.goto(SEND_CODE_URL, { waitUntil: 'load' });
    await page.click('label[for="ra2"]');
    await page.fill('input.form-control.col-md-3', phone);
    await page.click('input[type="button"].btn-primary');
    await page.waitForTimeout(2000);
    console.log(`已發送 場景登入 驗證碼給 ${phone}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  for (const event of req.body.events) {
    if (event.type === 'message' && event.message.type === 'text') {
      handleMessage(event).catch(console.error);
    }
  }
});

// 暫存手機號碼，等待 30 秒內出現「驗證碼」關鍵字
// key: userId, value: { phone, timestamp }
const pendingPhones = new Map();

// 每分鐘清理過期的暫存（超過 30 秒）
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of pendingPhones) {
    if (now - data.timestamp > 30000) pendingPhones.delete(userId);
  }
}, 60000);

async function handleMessage(event) {
  const text = event.message.text;
  const userId = event.source.userId;

  // 移除空白與常見符號後找手機號碼
  const cleaned = text.replace(/[\s\-\(\)\+\.\,\/]/g, '');
  const phoneMatch = cleaned.match(/09\d{8}/);
  const hasKeyword = text.includes('驗證碼');

  let phone = null;

  if (phoneMatch && hasKeyword) {
    // 同一則訊息同時包含手機號碼和「驗證碼」→ 直接觸發
    phone = phoneMatch[0];
    pendingPhones.delete(userId);
  } else if (phoneMatch) {
    // 只有手機號碼 → 暫存，等待「驗證碼」
    pendingPhones.set(userId, { phone: phoneMatch[0], timestamp: Date.now() });
    return;
  } else if (hasKeyword) {
    // 只有「驗證碼」→ 檢查 30 秒內是否有暫存的手機號碼
    const pending = pendingPhones.get(userId);
    if (pending && (Date.now() - pending.timestamp) <= 30000) {
      phone = pending.phone;
      pendingPhones.delete(userId);
    } else {
      return; // 沒有暫存手機號碼，忽略
    }
  } else {
    return; // 兩者都沒有，忽略
  }

  try {
    await sendCodes(phone);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `手機號碼${phone} 已設定驗證碼，請客人於驗證碼處輸入123456。此驗證碼2小時內有效。`,
      }],
    });
  } catch (err) {
    console.error('處理失敗:', err);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `發送失敗，請手動操作或稍後再試。\n錯誤：${err.message}`,
      }],
    });
  }
}

// 健康檢查端點（讓 UptimeRobot 保持服務運作）
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LINE Bot 已啟動，Port: ${PORT}`));
