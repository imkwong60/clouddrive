/**
 * Multi-cloud config.
 *
 * 前端部署：GitHub Pages
 *   https://imkwong60.github.io/microsoft/
 *
 * Token 交換後端（GitHub Pages 是靜態站，不能跑 serverless）：
 *   預設仍用 Vercel 上的 /api/token 代換 code / refresh。
 *   之後若換後端，只改下方 tokenEndpoint 即可。
 *
 * Client secret 絕不放前端，只存在後端環境變數（例如 Vercel MS_CLIENT_SECRET）。
 */
window.CLOUD_CONFIG = {
  // 預設雲端（可被 localStorage 覆寫）
  defaultProvider: "google",

  /**
   * 所有 provider 共用的 OAuth redirect 與 token 代理。
   * 新增其他雲端（Dropbox、Box…）時：
   *   1. 在 providers 加一筆
   *   2. 在 ui.js 的 listFiles / uploadFile / downloadFileBlob / fetchUserProfile 加分支
   *   3. 後端 api/token.js 的 PROVIDERS 加對應 token URL（若該雲端也需要 secret）
   */
  // 必須與 Google Cloud Console + Azure 應用程式裡登記的 Redirect URI 完全一致（含尾端 /）
  redirectUri: "https://imkwong60.github.io/microsoft/",

  // 絕對網址：前端在 GitHub Pages，token 代理在 Vercel（可改）
  tokenEndpoint: "https://microsoft-phi-three.vercel.app/api/token",

  providers: {
    google: {
      id: "google",
      label: "Google Drive",
      shortLabel: "Google",
      brand: "GOOGLE DRIVE",
      clientId: "978083976906-oicde1ab0nnd9d3q1v4hifialbqd3a8g.apps.googleusercontent.com",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email"
      ],
      authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      authExtra: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true"
      }
    },
    microsoft: {
      id: "microsoft",
      label: "OneDrive",
      shortLabel: "OneDrive",
      brand: "MICROSOFT ONEDRIVE",
      clientId: "7fe6bd89-67dd-4255-a1fd-cc52d369f2df",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
        "Files.ReadWrite"
      ],
      // /common：個人 Microsoft 帳戶 + 工作/學校帳戶
      authEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      authExtra: {
        response_mode: "query"
      }
    }
  }
};

// 每個 provider 自動補上共用的 redirectUri / tokenEndpoint，方便之後擴充
Object.keys(window.CLOUD_CONFIG.providers).forEach(function (id) {
  var p = window.CLOUD_CONFIG.providers[id];
  if (!p.redirectUri) p.redirectUri = window.CLOUD_CONFIG.redirectUri;
  if (!p.tokenEndpoint) p.tokenEndpoint = window.CLOUD_CONFIG.tokenEndpoint;
});

// 向後相容舊程式碼
window.GDRIVE_CONFIG = window.CLOUD_CONFIG.providers.google;
