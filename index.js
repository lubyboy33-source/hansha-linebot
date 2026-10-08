const express = require('express');
const { messagingApi, middleware } = require('@line/bot-sdk');
const { chromium } = require('playwright');
const { extractPhones, hasKeyword } = require('./parse');

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

const PENDING_WINDOW_MS = 2 * 60 * 1000; // 分兩則訊息時，兩則間隔上限
const STEP_TIMEOUT_MS = 15000;           // 單一頁面操作等待上限

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

process.on('unhandledRejection', (err) => log('unhandledRejection:', err));
process.on('uncaughtException', (err) => log('uncaughtException:', err));

async function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

const isLoginPage = (page) => page.url().toLowerCase().includes('/login');

async function doLogin(page) {
  if (!isLoginPage(page)) await page.goto(LOGIN_URL, { waitUntil: 'load' });
  await page.fill('input[placeholder="account"]', process.env.HANSHA_USERNAME);
  await page.fill('input[placeholder="password"]', process.env.HANSHA_PASSWORD);
  await page.press('input[placeholder="password"]', 'Enter');
  // 等到離開登入頁（不用 waitForURL，避免 ERR_ABORTED）
  await page.waitForFunction(
    () => !location.href.toLowerCase().includes('/login'),
    null,
    { timeout: 20000 },
  );
  log('登入完成，URL:', page.url());
}

// 開啟發送頁，確定表單已出現；被導回登入頁就登入後重試
async function openSendPage(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(SEND_CODE_URL, { waitUntil: 'load' });
    if (isLoginPage(page)) {
      await doLogin(page);
      await page.goto(SEND_CODE_URL, { waitUntil: 'load' });
    }
    try {
      await page.waitForSelector('label[for="ra1"]', { timeout: STEP_TIMEOUT_MS });
      return;
    } catch (err) {
      log(`發送頁表單未出現（第 ${attempt} 次），URL: ${page.url()}`);
      if (attempt === 2) throw new Error('無法開啟後台發送驗證碼頁面（可能登入失敗）');
    }
  }
}

async function sendOne(page, phone, radioFor, label) {
  await openSendPage(page);
  await page.click(`label[for="${radioFor}"]`);
  await page.fill('input.form-control.col-md-3', phone);
  await page.click('input[type="button"].btn-primary');
  await page.waitForTimeout(2000);
  log(`已發送 ${label} 驗證碼給 ${phone}`);
}

async function sendCodes(phone) {
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(30000);
    // 後台若以 alert 回報結果，記錄內容後關閉
    page.on('dialog', async (dialog) => {
      log(`後台訊息（${phone}）：${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });

    await sendOne(page, phone, 'ra1', 'APP登入');
    await sendOne(page, phone, 'ra2', '場景登入');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function sendCodesWithRetry(phone) {
  try {
    await sendCodes(phone);
  } catch (err) {
    log(`第一次發送失敗（${phone}）：${err.message}，重試一次`);
    await sendCodes(phone);
  }
}

// 一次只跑一個瀏覽器，避免免費主機記憶體不足而重啟
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

// 先試 reply（免費）；reply token 過期或失敗時改用 push 發到原群組/聊天室
async function notify(event, text) {
  const messages = [{ type: 'text', text }];
  try {
    await client.replyMessage({ replyToken: event.replyToken, messages });
    return;
  } catch (err) {
    log('reply 失敗，改用 push：', err.message);
  }
  const to = event.source.groupId || event.source.roomId || event.source.userId;
  try {
    await client.pushMessage({ to, messages });
  } catch (err) {
    log('push 也失敗：', err.message);
  }
}

// 去除 LINE 重送造成的重複事件
const seenEvents = new Map();
function isDuplicate(event) {
  const id = event.webhookEventId;
  if (!id) return false;
  if (seenEvents.has(id)) return true;
  seenEvents.set(id, Date.now());
  return false;
}

// 分兩則訊息時的暫存，以「群組/聊天室」為單位（不同人分開傳也能配對）
// key: groupId | roomId | userId, value: { phones, phoneAt, keywordAt }
const pending = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of pending) {
    if (now - Math.max(data.phoneAt || 0, data.keywordAt || 0) > PENDING_WINDOW_MS) pending.delete(key);
  }
  for (const [id, t] of seenEvents) {
    if (now - t > 10 * 60 * 1000) seenEvents.delete(id);
  }
}, 60000);

function resolvePhones(event) {
  const text = event.message.text;
  const key = event.source.groupId || event.source.roomId || event.source.userId;
  const phones = extractPhones(text);
  const keyword = hasKeyword(text);
  const now = Date.now();
  const entry = pending.get(key) || {};

  if (phones.length && keyword) {
    pending.delete(key);
    return phones;
  }
  if (phones.length) {
    if (entry.keywordAt && now - entry.keywordAt <= PENDING_WINDOW_MS) {
      pending.delete(key);
      return phones;
    }
    pending.set(key, { phones, phoneAt: now });
    log(`暫存手機號碼 ${phones.join(',')}，等待驗證碼關鍵字`);
    return null;
  }
  if (keyword) {
    if (entry.phoneAt && now - entry.phoneAt <= PENDING_WINDOW_MS) {
      pending.delete(key);
      return entry.phones;
    }
    pending.set(key, { keywordAt: now });
    log('暫存驗證碼關鍵字，等待手機號碼');
    return null;
  }
  return null;
}

async function handleMessage(event) {
  const phones = resolvePhones(event);
  if (!phones) return;

  const started = Date.now();
  log(`觸發：${phones.join(',')}，訊息：「${event.message.text.slice(0, 80)}」`);

  const ok = [];
  const failed = [];
  for (const phone of phones) {
    try {
      await enqueue(() => sendCodesWithRetry(phone));
      ok.push(phone);
    } catch (err) {
      log(`處理失敗（${phone}）：`, err);
      failed.push(`${phone}（${err.message}）`);
    }
  }
  log(`處理完成，耗時 ${Math.round((Date.now() - started) / 1000)} 秒`);

  const lines = ok.map((p) => `手機號碼${p} 已設定驗證碼，請客人於驗證碼處輸入123456。此驗證碼2小時內有效。`);
  if (failed.length) lines.push(`發送失敗，請手動操作或稍後再試：\n${failed.join('\n')}`);
  await notify(event, lines.join('\n\n'));
}

app.post('/webhook', middleware(lineConfig), (req, res) => {
  res.json({ status: 'ok' });
  for (const event of req.body.events) {
    if (event.type === 'message' && event.message.type === 'text' && !isDuplicate(event)) {
      handleMessage(event).catch((err) => log('handleMessage 錯誤：', err));
    }
  }
});

// 健康檢查端點（cron-job.org 定時 ping，保持服務運作）
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`LINE Bot 已啟動，Port: ${PORT}`));
