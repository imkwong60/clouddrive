/**
 * Multi-cloud config. Client secret 絕不放在前端，只存在 Vercel 環境變數。
 * Google: 可用 PKCE 公開用戶端；token 仍走 /api/token 以統一流程。
 * Microsoft: 必須用後端交換（client_secret 在 Vercel）。
 */
window.CLOUD_CONFIG = {
  // 預設雲端（可被 localStorage 覆寫）
  defaultProvider: "google",

  providers: {
    google: {
      id: "google",
      label: "Google Drive",
      shortLabel: "Google",
      brand: "GOOGLE DRIVE",
      clientId: "978083976906-oicde1ab0nnd9d3q1v4hifialbqd3a8g.apps.googleusercontent.com",
      redirectUri: "https://microsoft-phi-three.vercel.app/",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email"
      ],
      authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      // 實際 token 交換走同源 /api/token
      tokenEndpoint: "/api/token",
      // Google 專用額外參數
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
      redirectUri: "https://microsoft-phi-three.vercel.app/",
      // Graph 委派權限：讀寫自己的檔案 + 離線 refresh + 基本資料
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
        "Files.ReadWrite"
      ],
      // /common 同時支援個人 Microsoft 帳戶與工作/學校帳戶
      authEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "/api/token",
      authExtra: {
        response_mode: "query"
      }
    }
  }
};

// 向後相容舊程式碼
window.GDRIVE_CONFIG = window.CLOUD_CONFIG.providers.google;
