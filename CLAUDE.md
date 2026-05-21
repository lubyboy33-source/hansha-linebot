# hansha-linebot 專案說明

## 專案目的
LINE Bot 自動化工具，部署於 Render.com 雲端。當群組或私訊收到含有手機號碼 + 驗證碼關鍵字的訊息時，自動登入寒舍後台系統，對該手機號碼發送驗證碼（APP登入 + 場景登入各一次），並回覆 LINE 確認訊息。

## 觸發條件
以下任一情況都會觸發：
1. **同一則訊息**同時含有手機號碼（09XXXXXXXX 格式）和「驗證碼」三個字
2. **分開兩則訊息**：先傳手機號碼，30 秒內再傳「驗證碼」（或順序相反）

## 回覆內容
`手機號碼09XXXXXXXX 已設定驗證碼，請客人於驗證碼處輸入123456。`

## 架構
- **框架**：Node.js + Express
- **LINE SDK**：@line/bot-sdk
- **瀏覽器自動化**：Playwright（Headless Chromium）
- **部署**：Render.com（Free tier，Docker 部署）
- **保活**：cron-job.org 每 5 分鐘 ping /health 防止 Render 睡眠

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

## 主要檔案
- `index.js`：主程式（webhook 接收、訊息解析、瀏覽器自動化）
- `Dockerfile`：使用 node:20-slim + 系統 Chromium
- `railway.toml`：指定 Dockerfile 建置（舊的 Railway 設定，目前用 Render）
