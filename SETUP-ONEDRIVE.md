# 雲端檔案 PWA — Google Drive + OneDrive 設定說明

## 已完成的改動

- 側欄新增 **Google / OneDrive** 切換
- 每個雲端的登入 token、個人資料、離線佇列、清單快取 **彼此獨立**
- OAuth 仍用 **PKCE**；token 交換與 refresh 一律走同源 `/api/token`
- **Microsoft client secret 只存在 Vercel 環境變數**，不會出現在前端

## Vercel 環境變數（必要）

在 Vercel 專案 → Settings → Environment Variables 新增：

| 名稱 | 值 | 說明 |
|------|-----|------|
| `MS_CLIENT_SECRET` | （你提供的 secret） | Azure 應用程式密碼，**必要** |
| `MS_CLIENT_ID` | `7fe6bd89-67dd-4255-a1fd-cc52d369f2df` | 可選（已有預設） |
| `GOOGLE_CLIENT_ID` | 既有 Google client id | 可選 |
| `GOOGLE_CLIENT_SECRET` | （若 Google 為 Web 用戶端且有 secret） | 可選；純 SPA PKCE 可不設 |
| `ALLOWED_ORIGIN` | `https://microsoft-phi-three.vercel.app` | 可選，CORS |

部署後請重新 Deploy 一次讓 env 生效。

## Azure 應用程式（Microsoft Entra）檢查清單

1. **Redirect URI**（平台建議選 **單頁應用程式 SPA** 或 **Web**）  
   必須與 `authConfig.js` 一致：  
   `https://microsoft-phi-three.vercel.app/`

2. **支援的帳戶類型**  
   建議：「任何組織目錄中的帳戶和個人 Microsoft 帳戶」  
   （對應 token endpoint 的 `/common`）

3. **API 權限（委派）**  
   - `User.Read`  
   - `Files.ReadWrite`  
   - 並在授權時帶 `offline_access`（前端 scope 已包含）

4. **用戶端密碼**  
   在「憑證和密碼」建立 secret，值只填進 Vercel 的 `MS_CLIENT_SECRET`。

## Google Cloud Console

Redirect URI 維持：`https://microsoft-phi-three.vercel.app/`  
既有設定可繼續使用。

## 部署檔案

把 `artifacts/` 內這些檔案放到你的 Vercel 專案根目錄（或既有結構）：

```
index.html
authConfig.js
ui.js
style.css
theme-cream.css
manifest.json
sw.js
api/token.js
vercel.json
```

（icon-192.png / icon-512.png 請沿用你原本的圖示。）

## 安全提醒

你在對話中貼過 **client secret**。若此對話或 repo 可能外流，請到 Azure 入口 **立刻輪替（rotate）密碼**，並只把新 secret 放在 Vercel env，不要寫進任何前端檔案或 git。

## 使用方式

1. 開啟 App → 側欄「雲端服務」點 **OneDrive**
2. 點帳戶 → 走 Microsoft 登入
3. 登入成功後即可列出 / 上傳 / 下載 OneDrive 檔案
4. 切回 **Google** 會載入原本的 Google 登入狀態（若有）

兩邊可同時保持登入；切換只是切換目前使用的雲端與對應 token。
