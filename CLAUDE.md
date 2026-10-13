# hansha-linebot 專案說明

## 專案目的
LINE Bot 自動化工具，部署於 Render.com 雲端。當群組或私訊收到含有手機號碼 + 驗證碼關鍵字的訊息時，自動登入寒舍後台系統，對該手機號碼發送驗證碼（APP登入 + 場景登入各一次），並回覆 LINE 確認訊息。

## 觸發條件
以下任一情況都會觸發（解析邏輯在 `parse.js`）：
1. **同一則訊息**同時含有手機號碼和驗證碼關鍵字
2. **分開兩則訊息**：同一群組/聊天室內，手機號碼與關鍵字 2 分鐘內先後出現（順序不拘、可不同人傳）

- 手機號碼：09XXXXXXXX，支援 +886/886 開頭、全形數字、各種分隔符號（- 空白 . ‧ － 等）；一則最多 3 組
- 關鍵字：驗證碼、驗証碼、验证码、認證碼、认证码、收不到簡訊、OTP

## 回覆內容
`手機號碼09XXXXXXXX 已設定驗證碼，請客人於驗證碼處輸入123456。此驗證碼2小時內有效。`
- 先用 reply（免費）；reply token 約 1 分鐘失效，處理太久時自動改用 push 發到原群組（會用到 LINE 每月推播額度）
- 失敗時一樣會回報「發送失敗，請手動操作」

## 架構
- **框架**：Node.js + Express
- **LINE SDK**：@line/bot-sdk
- **瀏覽器自動化**：Playwright（Headless Chromium）
- **部署**：Render.com（Free tier，Docker 部署）
- **保活**：cron-job.org 每 5 分鐘 ping /health 防止 Render 睡眠；另有 GitHub Actions `.github/workflows/keepalive.yml` 每 5 分鐘補打一次（repo 60 天無 commit 時 GitHub 會自動停用排程，需到 Actions 頁重新啟用）

## 目標網站
- 登入頁：`https://d34k8i6r6n78f2.cloudfront.net/home/login`
- 發送驗證碼頁：`https://d34k8i6r6n78f2.cloudfront.net/system/SendLoginCode`
- 登入帳密：環境變數 HANSHA_USERNAME / HANSHA_PASSWORD（值為 mhhgroup3/mhhgroup3）
- 表單：`label[for="ra1"]`（APP登入）、`label[for="ra2"]`（場景登入）、`input.form-control.col-md-3`（手機欄位）、`input[type="button"].btn-primary`（送出）

## 環境變數（已設定在 Render）
| 變數名稱 | 說明 |
|----------|------|
| LINE_CHANNEL_SECRET | LINE 頻道密鑰 |
| LINE_CHANNEL_ACCESS_TOKEN | LINE 存取金鑰 |
| HANSHA_USERNAME | 寒舍後台帳號（mhhgroup3） |
| HANSHA_PASSWORD | 寒舍後台密碼（mhhgroup3） |
| PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH | /usr/bin/chromium（Dockerfile 設定） |

## 部署流程
1. 修改程式碼
2. `git add . && git commit -m "說明" && git push origin main`
3. Render 自動偵測 GitHub 更新並重新部署（約 3-5 分鐘）

## 重要服務連結
- GitHub Repo：https://github.com/lubyboy33-source/hansha-linebot
- Render Dashboard：https://dashboard.render.com
- Render 服務 URL：https://hansha-linebot.onrender.com
- LINE Developers：https://developers.line.biz
- cron-job.org：https://console.cron-job.org

## 已知問題與解法
- 登入後用 `waitForTimeout(5000)` 等待，不用 `waitForURL`（避免 ERR_ABORTED）
- Radio button 要點 `label[for="ra1"]` 而非 `#ra1`（label 會攔截點擊）
- 每次請求建立獨立 browser，不共用 context（避免 frame detached 錯誤）
- 登入後改等「離開登入頁」+「發送表單出現」，不再固定等 5 秒；被導回登入頁會重登一次
- 瀏覽器任務排隊一次只跑一個（免費主機 512MB，同時開兩個 Chromium 會被 OOM 重啟）
- 整段發送失敗自動重試一次；LINE 重送事件以 webhookEventId 去重
- 2026-10-08 曾發生「0925994490 收不到驗證碼」沒有任何回覆：辨識正常，推測為處理超過 1 分鐘致 reply token 失效、錯誤訊息也送不出，已加 push 備援
- Render Logs 每行有時間戳，可搜尋「觸發」「處理完成，耗時」「reply 失敗」「處理失敗」排查

## 主要檔案
- `index.js`：主程式（webhook 接收、配對暫存、排隊、瀏覽器自動化、回覆）
- `parse.js`：手機號碼與關鍵字解析
- `Dockerfile`：使用 node:20-slim + 系統 Chromium
- `railway.toml`：指定 Dockerfile 建置（舊的 Railway 設定，目前用 Render）

## 2026-10-13 第一則沒反應、第二則才觸發
- LINE Developers 檢查：Webhook redelivery 與 Error statistics aggregation 原本皆為關閉
- Render Logs 證實：09:35:57 才出現「LINE Bot 已啟動」（休眠喚醒），第一則訊息遺失；09:37 第二則正常觸發，處理耗時 32 秒
- 10/8–10/12 每天休眠喚醒約 5–14 次，cron-job.org 保活實際未生效（帳號無法登入確認）
- 已加 GitHub Actions 保活，手動執行 #1 成功
- Render 用 GitHub（lubyboy33-source）登入；Logs 可搜尋「已啟動」看休眠喚醒次數
