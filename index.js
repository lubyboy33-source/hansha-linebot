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

let browser = null;
let browserContext = null;

async function getContext() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browserContext = await browser.newContext();
  }
  return browserContext;
}

async function doLogin(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="account"]', process.env.HANSHA_USERNAME);
  await page.fill('input[placeholder="password"]', process.env.HANSHA_PASSWORD);
  await page.press('input[placeholder="password"]', 'Enter');
  await page.waitForURL(`${BASE_URL}/system/**`, { timeout: 15000 });
  console.log('登入成功');
}

async function ensureLoggedIn(page) {
  await page.goto(SEND_CODE_URL, { waitUntil: 'networkidle' });
  if (page.url().includes('/login') || page.url().includes('/Login')) {
    await doLogin(page);
    await page.goto(SEND_CODE_URL, { waitUntil: 'networkidle' });
  }
}

async function sendCode(phone, scenario) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await ensureLoggedIn(page);

    // 選 APP登入(1) 或 場景登入(2)
    await page.click(`#ra${scenario}`);

    // 填手機號碼
    await page.fill('input.form-control.col-md-3', phone);

    // 點重送驗證碼
    await page.click('input[type="button"].btn-primary');

    // 等待請求完成
    await page.waitForTimeout(2000);

    const typeName = scenario === 1 ? 'APP登入' : '場景登入';
    console.log(`已發送 ${typeName} 驗證碼給 ${phone}`);
  } finally {
    await page.close();
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

async function handleMessage(event) {
  const text = event.message.text;

  // 移除空白與常見符號後找手機號碼
  const cleaned = text.replace(/[\s\-\(\)\+\.\,\/]/g, '');
  const phoneMatch = cleaned.match(/09\d{8}/);
  if (!phoneMatch) return;

  const phone = phoneMatch[0];

  // 從訊息其餘部分找驗證碼（4-6位數字），沒有就不觸發
  const remaining = cleaned.replace(phone, '');
  const codeMatch = remaining.match(/\d{4,6}/);
  if (!codeMatch) return;
  const code = codeMatch[0];

  try {
    await sendCode(phone, 1); // APP登入
    await sendCode(phone, 2); // 場景登入

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `手機號碼${phone} 已設定驗證碼，請客人於驗證碼處輸入${code}。`,
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
