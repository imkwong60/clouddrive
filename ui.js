(() => {
  "use strict";

  const CLOUD = window.CLOUD_CONFIG;
  if (!CLOUD || !CLOUD.providers) {
    console.error("CLOUD_CONFIG missing. Check authConfig.js");
    return;
  }

  const PROVIDER_KEY = "cloud.activeProvider";
  const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
  const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
  const UPLOAD_RETRY_LIMIT = 3;

  function getActiveProviderId() {
    const saved = localStorage.getItem(PROVIDER_KEY);
    if (saved && CLOUD.providers[saved]) return saved;
    return CLOUD.defaultProvider || "google";
  }

  function setActiveProviderId(id) {
    if (!CLOUD.providers[id]) return;
    localStorage.setItem(PROVIDER_KEY, id);
  }

  function getConfig() {
    return CLOUD.providers[getActiveProviderId()];
  }

  function tokenStorageKey() {
    return "cloud.oauth.tokens." + getActiveProviderId();
  }
  function authFlowKey() {
    return "cloud.oauth.flow." + getActiveProviderId();
  }
  function profileKey() {
    return "cloud.profile." + getActiveProviderId();
  }
  function queueDbName() {
    return "cloud-offline-queue-" + getActiveProviderId();
  }
  function cacheKey(folderId) {
    return "cloud.snapshot." + getActiveProviderId() + "." + (folderId || "root");
  }

  const state = {
    account: null,
    items: [],
    pending: [],
    folderId: null,
    folderName: "",
    filter: "all",
    view: "all",
    sortAscending: true,
    isLoading: false,
    isUploading: false,
    uploadingFromModal: false,
    previewItem: null,
    previewUrl: null,
    previewRequestId: 0,
    loadError: ""
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    fileGrid: $("#fileGrid"),
    emptyState: $("#emptyState"),
    loadingState: $("#loadingState"),
    fileSummary: $("#fileSummary"),
    fileCount: $("#fileCount"),
    overviewFiles: $("#overviewFiles"),
    overviewStorage: $("#overviewStorage"),
    overviewSync: $("#overviewSync"),
    overviewSyncCaption: $("#overviewSyncCaption"),
    syncStatus: $("#syncStatus"),
    allTabCount: $("#allTabCount"),
    searchInput: $("#searchInput"),
    pageTitle: $("#pageTitle"),
    pageDescription: $("#pageDescription"),
    breadcrumbCurrent: $("#breadcrumbCurrent"),
    uploadModal: $("#uploadModal"),
    filePicker: $("#filePicker"),
    selectedFiles: $("#selectedFiles"),
    confirmUploadButton: $("#confirmUploadButton"),
    dropzone: $("#dropzone"),
    uploadProgress: $("#uploadProgress"),
    uploadProgressName: $("#uploadProgressName"),
    uploadProgressPercent: $("#uploadProgressPercent"),
    uploadProgressBar: $("#uploadProgressBar"),
    uploadProgressDetail: $("#uploadProgressDetail"),
    imagePreviewModal: $("#imagePreviewModal"),
    previewImage: $("#previewImage"),
    previewSpinner: $("#previewSpinner"),
    previewCaption: $("#previewCaption"),
    toastRegion: $("#toastRegion")
  };

  let selectedFiles = [];
  let toastId = 0;
  let preparedAuthRequest = null;
  let authPreparationPending = false;
  let authPreparationError = null;
  let refreshPromise = null;
  let loadSeq = 0;
  let lastLoadAt = 0;
  let authKind = "out";
  let profileOk = false;

  const delay = (ms) => new Promise((r) => window.setTimeout(r, ms));

  // ─── Toast ───────────────────────────────────────────────
  function showToast(message, type = "success", duration = 2800) {
    const toast = document.createElement("div");
    const icon = document.createElement("span");
    const text = document.createElement("span");
    const close = document.createElement("button");
    const id = ++toastId;
    toast.className = "toast " + (type === "error" ? "error" : type === "info" ? "info" : "");
    toast.dataset.toastId = String(id);
    icon.className = "toast-icon";
    icon.innerHTML = type === "error"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>'
      : type === "info"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v5m0-8h.01"/><circle cx="12" cy="12" r="9"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    text.className = "toast-message";
    text.textContent = message;
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", "關閉提示");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener("click", () => dismissToast(toast));
    toast.append(icon, text, close);
    elements.toastRegion.append(toast);
    window.setTimeout(() => dismissToast(toast), duration);
  }

  function dismissToast(toast) {
    if (!toast.isConnected || toast.classList.contains("leaving")) return;
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 260);
  }

  // ─── IndexedDB offline queue (per provider) ──────────────
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(queueDbName(), 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("uploads")) {
          db.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("無法開啟本機離線儲存空間"));
    });
  }

  async function queueTransaction(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("uploads", mode);
      const store = transaction.objectStore("uploads");
      let request;
      try {
        request = operation(store);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        resolve(request ? request.result : undefined);
        db.close();
      };
      transaction.onerror = () => {
        reject(transaction.error || new Error("本機離線佇列操作失敗"));
        db.close();
      };
      transaction.onabort = () => {
        reject(transaction.error || new Error("本機離線佇列操作已中止"));
        db.close();
      };
    });
  }

  function getQueuedUploads() {
    return queueTransaction("readonly", (store) => store.getAll());
  }

  function addQueuedUpload(file, folderId) {
    return queueTransaction("readwrite", (store) => store.add({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      folderId,
      blob: file,
      queuedAt: Date.now()
    }));
  }

  function removeQueuedUpload(id) {
    return queueTransaction("readwrite", (store) => store.delete(id));
  }

  // ─── Token storage ──────────────────────────────────────
  function getTokens() {
    try {
      const saved = localStorage.getItem(tokenStorageKey());
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error("無法讀取登入狀態:", error);
      return {};
    }
  }

  function setTokens(tokens) {
    localStorage.setItem(tokenStorageKey(), JSON.stringify(tokens));
  }

  function clearTokens() {
    localStorage.removeItem(tokenStorageKey());
  }

  function clearExpiredAuthFlow() {
    try {
      const authFlow = JSON.parse(localStorage.getItem(authFlowKey()) || "null");
      if (authFlow && Date.now() - Number(authFlow.createdAt) > 10 * 60 * 1000) {
        localStorage.removeItem(authFlowKey());
      }
    } catch (error) {
      try { localStorage.removeItem(authFlowKey()); } catch (_) {}
    }
  }

  // ─── PKCE helpers ───────────────────────────────────────
  function randomString(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function base64UrlEncode(buffer) {
    let binary = "";
    new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function createCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64UrlEncode(digest);
  }

  async function createAuthorizationRequest() {
    const config = getConfig();
    const verifier = randomString(48);
    const challenge = await createCodeChallenge(verifier);
    const oauthState = randomString(24);
    const authorizeUrl = new URL(config.authEndpoint);
    const params = {
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: oauthState,
      ...(config.authExtra || {})
    };
    authorizeUrl.search = new URLSearchParams(params).toString();
    return { verifier, state: oauthState, url: authorizeUrl.toString() };
  }

  function prepareAuthorizationRequest() {
    if (authPreparationPending || preparedAuthRequest) return;
    authPreparationPending = true;
    authPreparationError = null;
    createAuthorizationRequest()
      .then((request) => { preparedAuthRequest = request; })
      .catch((error) => {
        authPreparationError = error;
        console.error("登入初始化失敗:", error);
      })
      .finally(() => { authPreparationPending = false; });
  }

  function signIn() {
    if (!navigator.onLine) {
      showToast("目前離線，連線後即可登入。", "info");
      return;
    }
    if (!preparedAuthRequest) {
      showToast(authPreparationError
        ? "登入準備失敗，請重新載入頁面後再試。"
        : "登入功能正在準備，請稍後再試。", authPreparationError ? "error" : "info");
      prepareAuthorizationRequest();
      return;
    }
    const request = preparedAuthRequest;
    try {
      localStorage.setItem(authFlowKey(), JSON.stringify({
        verifier: request.verifier,
        state: request.state,
        provider: getActiveProviderId(),
        createdAt: Date.now()
      }));
      preparedAuthRequest = null;
      window.location.href = request.url;
    } catch (error) {
      localStorage.removeItem(authFlowKey());
      console.error("登入初始化失敗:", error);
      showToast("無法開始登入，請稍後再試。", "error");
    }
  }

  async function exchangeAuthorizationCode() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return false;

    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    // 從任一 provider 的 flow key 找回（callback 回來時可能還在切換前）
    let authFlow = null;
    let flowProvider = getActiveProviderId();
    for (const pid of Object.keys(CLOUD.providers)) {
      try {
        const raw = localStorage.getItem("cloud.oauth.flow." + pid);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.state === returnedState) {
          authFlow = parsed;
          flowProvider = pid;
          setActiveProviderId(pid);
          break;
        }
      } catch (_) {}
    }
    if (!authFlow) {
      try {
        authFlow = JSON.parse(localStorage.getItem(authFlowKey()) || "null");
      } catch (_) {}
    }

    const expectedState = authFlow && authFlow.state;
    const verifier = authFlow && authFlow.verifier;
    Object.keys(CLOUD.providers).forEach((pid) => {
      try { localStorage.removeItem("cloud.oauth.flow." + pid); } catch (_) {}
    });

    if (!expectedState || returnedState !== expectedState || !verifier) {
      throw new Error("登入驗證未通過，請重新登入。");
    }
    if (oauthError) {
      const description = params.get("error_description");
      throw new Error(description || "登入已取消或失敗");
    }

    const config = getConfig();
    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        provider: getActiveProviderId(),
        client_id: config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
        scope: config.scopes.join(" ")
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || "無法完成登入");
    }
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || "",
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    });
    return true;
  }

  function refreshAccessToken() {
    if (!refreshPromise) {
      refreshPromise = doRefreshAccessToken().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function doRefreshAccessToken() {
    const tokens = getTokens();
    if (!tokens.refreshToken) throw new Error("登入已逾期，請重新連結帳戶。");
    const config = getConfig();
    let response;
    let payload = {};
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      response = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: controller.signal,
        body: new URLSearchParams({
          provider: getActiveProviderId(),
          client_id: config.clientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          scope: config.scopes.join(" ")
        })
      });
      try { payload = await response.json(); } catch (_) {}
    } catch (networkError) {
      throw new Error(networkError.name === "AbortError"
        ? "更新登入狀態逾時，請稍後重試"
        : "網路尚未就緒，無法更新登入狀態（" + (networkError.message || "網路錯誤") + "）");
    } finally {
      window.clearTimeout(timer);
    }
    if (!response.ok) {
      if (payload.error === "invalid_grant") {
        clearTokens();
        throw new Error("登入已逾期，請重新連結帳戶。");
      }
      throw new Error("更新登入狀態失敗（" + response.status + "）：" + (payload.error_description || payload.error || "伺服器錯誤"));
    }
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    });
    return payload.access_token;
  }

  async function getAccessToken(forceRefresh = false) {
    const tokens = getTokens();
    if (!forceRefresh && tokens.accessToken && Number(tokens.expiresAt) > Date.now() + 60000) {
      return tokens.accessToken;
    }
    return refreshAccessToken();
  }

  // ─── Provider API adapters ──────────────────────────────
  async function apiRequest(url, options = {}, retried = false) {
    const accessToken = await getAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + accessToken);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && !retried) {
      await getAccessToken(true);
      return apiRequest(url, options, true);
    }
    if (!response.ok) {
      let message = "雲端請求失敗（" + response.status + "）";
      try {
        const errorPayload = await response.json();
        message =
          (errorPayload.error && (errorPayload.error.message || errorPayload.error)) ||
          errorPayload.message ||
          message;
      } catch (_) {}
      throw new Error(typeof message === "string" ? message : "雲端請求失敗");
    }
    return response;
  }

  function normalizeGoogleFile(f) {
    return {
      id: f.id,
      name: f.name,
      size: Number(f.size) || 0,
      mimeType: f.mimeType,
      folder: f.mimeType === "application/vnd.google-apps.folder",
      file: f.mimeType !== "application/vnd.google-apps.folder",
      lastModifiedDateTime: f.modifiedTime,
      webUrl: f.webViewLink,
      thumbnailLink: f.thumbnailLink,
      iconLink: f.iconLink
    };
  }

  function normalizeGraphItem(item) {
    const isFolder = !!(item.folder);
    return {
      id: item.id,
      name: item.name,
      size: Number(item.size) || 0,
      mimeType: item.file && item.file.mimeType ? item.file.mimeType : (isFolder ? "application/folder" : "application/octet-stream"),
      folder: isFolder,
      file: !isFolder,
      lastModifiedDateTime: item.lastModifiedDateTime,
      webUrl: item.webUrl,
      thumbnailLink: null,
      downloadUrl: item["@microsoft.graph.downloadUrl"] || null
    };
  }

  async function listFiles() {
    const provider = getActiveProviderId();
    if (provider === "microsoft") {
      const parent = state.folderId
        ? "https://graph.microsoft.com/v1.0/me/drive/items/" + encodeURIComponent(state.folderId) + "/children"
        : "https://graph.microsoft.com/v1.0/me/drive/root/children";
      const url = parent + "?$top=200&$orderby=name&$select=id,name,size,file,folder,lastModifiedDateTime,webUrl,@microsoft.graph.downloadUrl";
      const response = await apiRequest(url);
      const data = await response.json();
      return (Array.isArray(data.value) ? data.value : []).map(normalizeGraphItem);
    }
    // Google
    const parent = state.folderId || "root";
    const q = "'" + parent + "' in parents and trashed = false";
    const fields = "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,thumbnailLink,parents)";
    const path = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&fields=" + encodeURIComponent(fields) + "&pageSize=200&orderBy=folder,name";
    const response = await apiRequest(path);
    const data = await response.json();
    return (Array.isArray(data.files) ? data.files : []).map(normalizeGoogleFile);
  }

  async function downloadFileBlob(item) {
    const provider = getActiveProviderId();
    if (provider === "microsoft") {
      if (item.downloadUrl) {
        const response = await fetch(item.downloadUrl);
        if (!response.ok) throw new Error("下載失敗（" + response.status + "）");
        return response.blob();
      }
      const response = await apiRequest(
        "https://graph.microsoft.com/v1.0/me/drive/items/" + encodeURIComponent(item.id) + "/content"
      );
      return response.blob();
    }
    const response = await apiRequest(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(item.id) + "?alt=media"
    );
    return response.blob();
  }

  async function fetchUserProfile() {
    const provider = getActiveProviderId();
    if (provider === "microsoft") {
      const response = await apiRequest("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,id");
      const profile = await response.json();
      return {
        displayName: profile.displayName || profile.userPrincipalName || "OneDrive 帳戶",
        email: profile.mail || profile.userPrincipalName || "",
        picture: ""
      };
    }
    const response = await apiRequest("https://www.googleapis.com/oauth2/v3/userinfo");
    const profile = await response.json();
    return {
      displayName: profile.name || profile.email || "Google 帳戶",
      email: profile.email || "",
      picture: profile.picture || ""
    };
  }

  async function uploadFileGoogle(file, folderId, onProgress) {
    if (file.size > SIMPLE_UPLOAD_LIMIT) {
      return uploadLargeFileGoogle(file, folderId, (uploadedBytes) => {
        onProgress((uploadedBytes / file.size) * 100, formatBytes(uploadedBytes) + " / " + formatBytes(file.size));
      });
    }
    const metadata = {
      name: file.name,
      parents: folderId ? [folderId] : undefined
    };
    const boundary = "-------gdriveboundary" + Date.now();
    const delimiter = "\r\n--" + boundary + "\r\n";
    const closeDelimiter = "\r\n--" + boundary + "--";
    const metaPart = delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata);
    const mediaPart = delimiter +
      "Content-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n";
    const body = new Blob([metaPart, mediaPart, file, closeDelimiter]);
    const response = await apiRequest(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body
      }
    );
    onProgress(100, formatBytes(file.size) + " / " + formatBytes(file.size));
    return response.json().catch(() => null);
  }

  async function uploadLargeFileGoogle(file, folderId, onProgress) {
    const metadata = {
      name: file.name,
      parents: folderId ? [folderId] : undefined
    };
    const initResponse = await apiRequest(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": file.type || "application/octet-stream",
          "X-Upload-Content-Length": String(file.size)
        },
        body: JSON.stringify(metadata)
      }
    );
    const sessionUrl = initResponse.headers.get("Location");
    if (!sessionUrl) throw new Error("無法建立 Google Drive 分段上傳工作階段");
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      let attempts = 0;
      for (;;) {
        try {
          const accessToken = await getAccessToken();
          const response = await fetch(sessionUrl, {
            method: "PUT",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Length": String(chunk.size),
              "Content-Range": "bytes " + offset + "-" + (end - 1) + "/" + file.size
            },
            body: chunk
          });
          if (response.status === 308 || response.status === 200 || response.status === 201) {
            offset = end;
            onProgress(offset);
            if (response.status === 200 || response.status === 201) {
              return response.json().catch(() => null);
            }
            break;
          }
          let message = "Google Drive 分段上傳失敗（" + response.status + "）";
          try {
            const payload = await response.json();
            if (payload.error && payload.error.message) message = payload.error.message;
          } catch (_) {}
          throw new Error(message);
        } catch (error) {
          if (!navigator.onLine) throw new Error("網路中斷；分段上傳未完成，請連線後重新選取檔案再試。");
          attempts += 1;
          if (attempts > UPLOAD_RETRY_LIMIT) throw error;
          await delay(attempts * 900);
        }
      }
    }
    return null;
  }

  async function uploadFileMicrosoft(file, folderId, onProgress) {
    const parentPath = folderId
      ? "https://graph.microsoft.com/v1.0/me/drive/items/" + encodeURIComponent(folderId)
      : "https://graph.microsoft.com/v1.0/me/drive/root";

    // 小檔：直接 PUT content
    if (file.size <= SIMPLE_UPLOAD_LIMIT) {
      const url = parentPath + ":/" + encodeURIComponent(file.name) + ":/content";
      const response = await apiRequest(url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      onProgress(100, formatBytes(file.size) + " / " + formatBytes(file.size));
      return response.json().catch(() => null);
    }

    // 大檔：createUploadSession
    const sessionResponse = await apiRequest(parentPath + ":/" + encodeURIComponent(file.name) + ":/createUploadSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: file.name
        }
      })
    });
    const session = await sessionResponse.json();
    const uploadUrl = session.uploadUrl;
    if (!uploadUrl) throw new Error("無法建立 OneDrive 上傳工作階段");

    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      let attempts = 0;
      for (;;) {
        try {
          const response = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Length": String(chunk.size),
              "Content-Range": "bytes " + offset + "-" + (end - 1) + "/" + file.size
            },
            body: chunk
          });
          if (response.status === 202 || response.status === 200 || response.status === 201) {
            offset = end;
            onProgress((offset / file.size) * 100, formatBytes(offset) + " / " + formatBytes(file.size));
            if (response.status === 200 || response.status === 201) {
              return response.json().catch(() => null);
            }
            break;
          }
          let message = "OneDrive 分段上傳失敗（" + response.status + "）";
          try {
            const payload = await response.json();
            if (payload.error && payload.error.message) message = payload.error.message;
          } catch (_) {}
          throw new Error(message);
        } catch (error) {
          if (!navigator.onLine) throw new Error("網路中斷；分段上傳未完成，請連線後重新選取檔案再試。");
          attempts += 1;
          if (attempts > UPLOAD_RETRY_LIMIT) throw error;
          await delay(attempts * 900);
        }
      }
    }
    return null;
  }

  async function uploadFile(file, folderId, onProgress) {
    if (getActiveProviderId() === "microsoft") {
      return uploadFileMicrosoft(file, folderId, onProgress);
    }
    return uploadFileGoogle(file, folderId, onProgress);
  }

  // ─── Cache ──────────────────────────────────────────────
  function cacheItems(items, folderId) {
    try {
      localStorage.setItem(cacheKey(folderId), JSON.stringify({ items, savedAt: Date.now() }));
    } catch (error) {
      console.warn("無法儲存檔案清單快取:", error);
    }
  }

  function readCachedItems(folderId) {
    try {
      const snapshot = JSON.parse(localStorage.getItem(cacheKey(folderId)) || "null");
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items : null;
    } catch (error) {
      return null;
    }
  }

  function showLoading(show) {
    state.isLoading = show;
    elements.loadingState.hidden = !show;
    elements.fileGrid.hidden = show;
    if (show) elements.emptyState.hidden = true;
    const refreshBtn = $("#refreshButton");
    if (refreshBtn) refreshBtn.classList.toggle("is-loading", show);
  }

  async function loadFiles(options = {}) {
    if (!state.account) {
      renderFiles();
      return;
    }
    const seq = ++loadSeq;
    if (!navigator.onLine || options.cachedOnly) {
      const cached = readCachedItems(state.folderId);
      if (cached) {
        state.items = cached;
        renderFiles();
        if (!navigator.onLine) showToast("目前離線，顯示上次同步的檔案清單。", "info", 2500);
      } else {
        state.items = [];
        renderFiles();
        showToast("此資料夾尚無離線快取，請連線後重新整理。", "info");
      }
      return;
    }
    lastLoadAt = Date.now();
    showLoading(true);
    try {
      let items;
      const timeouts = [6000, 8000, 12000];
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeouts[attempt]);
        try {
          // listFiles uses apiRequest which doesn't take signal; wrap with timeout via Abort on outer
          items = await Promise.race([
            listFiles(),
            new Promise((_, reject) => {
              controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("AbortError"), { name: "AbortError" })));
            })
          ]);
          break;
        } catch (err) {
          const timedOut = err && err.name === "AbortError";
          if (attempt >= timeouts.length - 1 || (!getTokens().refreshToken && !getTokens().accessToken)) {
            throw timedOut ? new Error("連線逾時，請檢查網路後按「重新載入」") : err;
          }
          if (!timedOut) await delay(800);
        } finally {
          window.clearTimeout(timer);
        }
      }
      if (seq !== loadSeq) return;
      state.loadError = "";
      setAuthStatus("ok");
      state.items = items;
      cacheItems(state.items, state.folderId);
      renderFiles();
    } catch (error) {
      if (seq !== loadSeq) return;
      console.error("讀取雲端檔案失敗:", error);
      state.loadError = error.message || "讀取雲端檔案失敗";
      if (getTokens().refreshToken || getTokens().accessToken) {
        setAuthStatus("error");
      } else {
        state.account = null;
        state.loadError = "";
        clearProfileUI();
      }
      const cached = readCachedItems(state.folderId);
      state.items = cached && cached.length ? cached : [];
      renderFiles();
      showToast(state.loadError, "error", 5000);
    } finally {
      if (seq === loadSeq) {
        showLoading(false);
        renderFiles();
      }
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return size.toFixed(size < 10 ? 1 : 0) + " " + units[unit];
  }

  function formatDate(dateString) {
    const label = getConfig().shortLabel;
    if (!dateString) return label;
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return label;
    return new Intl.DateTimeFormat("zh-Hant", { month: "short", day: "numeric" }).format(date);
  }

  function iconFor(item) {
    if (item.folder) return { type: "folder", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h5l2 2h7A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg>' };
    const ext = (item.name || "").split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "heic"].includes(ext) || (item.mimeType || "").startsWith("image/")) {
      return { type: "image", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 3.5 3 2-2 5.5 5"/></svg>' };
    }
    if (ext === "pdf" || item.mimeType === "application/pdf") {
      return { type: "pdf", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 16h2a1.5 1.5 0 0 0 0-3H8v5m5-5v5h1.2a2.5 2.5 0 0 0 0-5z"/></svg>' };
    }
    if (["doc", "docx", "txt", "rtf", "odt"].includes(ext) || (item.mimeType || "").includes("document")) {
      return { type: "document", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h4"/></svg>' };
    }
    if (["xls", "xlsx", "csv", "ods"].includes(ext) || (item.mimeType || "").includes("spreadsheet")) {
      return { type: "spreadsheet", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h7M11 11.5v7"/></svg>' };
    }
    if (["ppt", "pptx", "odp"].includes(ext) || (item.mimeType || "").includes("presentation")) {
      return { type: "presentation", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 17v-5h2.5a1.5 1.5 0 0 1 0 3H8"/></svg>' };
    }
    if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) {
      return { type: "archive", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M11 9v2m0 2v2m0 2v2m-1-7h2m-2 4h2"/></svg>' };
    }
    return { type: "generic", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4"/></svg>' };
  }

  function isImageFile(item) {
    if (!item || item.folder) return false;
    const ext = (item.name || "").split(".").pop().toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "bmp"].includes(ext) ||
      (item.mimeType || "").startsWith("image/");
  }

  function createFileCard(item, index, pending = false) {
    const card = document.createElement("button");
    const iconMeta = iconFor(item);
    card.className = "file-card" + (isImageFile(item) ? " image-card" : "") + (pending ? " is-pending" : "");
    card.type = "button";
    card.style.animationDelay = Math.min(index * 28, 280) + "ms";
    card.innerHTML =
      '<span class="file-icon icon-' + iconMeta.type + '">' + iconMeta.svg + "</span>" +
      '<span class="file-copy"><strong class="file-name"></strong><span class="file-meta"></span></span>' +
      '<span class="file-action" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></span>';
    card.querySelector(".file-name").textContent = item.name || "未命名";
    card.querySelector(".file-meta").textContent = pending
      ? "等待上傳 · " + formatBytes(item.size)
      : (item.folder ? "資料夾" : formatBytes(item.size)) + " · " + formatDate(item.lastModifiedDateTime);
    card.addEventListener("click", () => {
      if (pending) {
        showToast("此檔案仍在等待上傳。", "info");
        return;
      }
      if (item.folder) {
        state.folderId = item.id;
        state.folderName = item.name;
        loadFiles();
        return;
      }
      if (isImageFile(item)) {
        openImagePreview(item);
        return;
      }
      downloadFile(item);
    });
    return card;
  }

  function updateViewHeading() {
    const config = getConfig();
    const titles = {
      all: "所有檔案",
      folders: "資料夾",
      recent: "最近檔案"
    };
    const title = state.folderName || titles[state.view] || "所有檔案";
    elements.pageTitle.innerHTML = title + '<span class="title-period">.</span>';
    elements.breadcrumbCurrent.textContent = title;
    elements.pageDescription.textContent = state.folderId
      ? "正在瀏覽「" + state.folderName + "」"
      : "整理、管理你的檔案，隨時隨地安心存取。";
    // 更新側欄品牌
    const brandStrong = document.querySelector(".brand-copy strong");
    const brandSmall = document.querySelector(".brand-copy small");
    if (brandStrong) brandStrong.textContent = "雲端檔案";
    if (brandSmall) brandSmall.textContent = config.brand;
    const storageStrong = document.querySelector(".storage-heading strong");
    const storageSpan = document.querySelector(".storage-heading span");
    if (storageStrong) storageStrong.textContent = config.label;
    if (storageSpan) storageSpan.textContent = "雲端儲存空間";
    const providerLabel = document.getElementById("overviewProviderLabel");
    if (providerLabel) providerLabel.textContent = config.shortLabel;
  }

  function renderFiles() {
    updateViewHeading();
    let files = state.items.slice();
    if (state.filter === "files") files = files.filter((item) => item.file);
    if (state.filter === "folders") files = files.filter((item) => item.folder);
    if (state.view === "recent") {
      files = files.slice().sort((a, b) => {
        const ta = new Date(a.lastModifiedDateTime || 0).getTime();
        const tb = new Date(b.lastModifiedDateTime || 0).getTime();
        return tb - ta;
      }).slice(0, 40);
    } else {
      files.sort((a, b) => {
        if (a.folder !== b.folder) return a.folder ? -1 : 1;
        const cmp = (a.name || "").localeCompare(b.name || "", "zh-Hant");
        return state.sortAscending ? cmp : -cmp;
      });
    }
    const searchTerm = (elements.searchInput.value || "").trim().toLocaleLowerCase();
    if (searchTerm) files = files.filter((item) => (item.name || "").toLocaleLowerCase().includes(searchTerm));

    elements.fileGrid.replaceChildren();
    const pendingHere = state.pending.filter((file) => (file.folderId || null) === (state.folderId || null));
    pendingHere.forEach((file, index) => elements.fileGrid.append(createFileCard(file, index, true)));
    files.forEach((item, index) => elements.fileGrid.append(createFileCard(item, pendingHere.length + index)));

    const totalCount = state.items.length + pendingHere.length;
    elements.fileCount.textContent = totalCount || "—";
    elements.allTabCount.textContent = totalCount || "—";
    elements.overviewFiles.textContent = totalCount || "—";
    const totalSize = state.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    elements.overviewStorage.textContent = totalSize ? formatBytes(totalSize) : "—";

    const config = getConfig();
    if (state.account) {
      elements.overviewSync.textContent = navigator.onLine ? "已同步" : "離線";
      elements.overviewSyncCaption.textContent = navigator.onLine
        ? "檔案會安全儲存至 " + config.label
        : "目前離線，顯示快取清單";
      elements.syncStatus.textContent = navigator.onLine ? "準備就緒" : "離線";
      elements.fileSummary.textContent = files.length
        ? "顯示 " + files.length + " 個項目"
        : (state.loadError ? "讀取失敗，請重新載入" : state.isLoading ? "讀取中…" : searchTerm ? "找不到符合的檔案" : "此資料夾是空的");
    } else {
      elements.overviewSync.textContent = "未登入";
      elements.overviewSyncCaption.textContent = "連結帳戶後開始使用";
      elements.syncStatus.textContent = "尚未連線";
      elements.fileSummary.textContent = "連結帳戶以開始使用";
    }

    const showEmpty = !state.isLoading && files.length === 0 && pendingHere.length === 0;
    elements.emptyState.hidden = !showEmpty;
    elements.fileGrid.hidden = showEmpty || state.isLoading;
    if (showEmpty) {
      const emptyTitle = $("#emptyTitle");
      const emptyDescription = $("#emptyDescription");
      const emptyAction = $("#emptyAction");
      if (!state.account) {
        emptyTitle.textContent = "雲端空間準備好了";
        emptyDescription.textContent = "登入帳戶，開始瀏覽你的 " + config.label + " 檔案。";
        emptyAction.textContent = "連結 " + config.shortLabel + " 帳戶";
      } else if (state.loadError) {
        emptyTitle.textContent = "暫時無法讀取檔案";
        emptyDescription.textContent = state.loadError;
        emptyAction.textContent = "重新載入";
      } else {
        emptyTitle.textContent = "此資料夾是空的";
        emptyDescription.textContent = "上傳檔案或建立資料夾來開始整理。";
        emptyAction.textContent = "上傳檔案";
      }
    }
  }

  async function downloadFile(item) {
    try {
      showToast("正在準備下載「" + item.name + "」…", "info", 2000);
      const blob = await downloadFileBlob(item);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name || "download";
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      console.error("下載失敗:", error);
      showToast("下載失敗：" + error.message, "error", 4000);
    }
  }

  async function openImagePreview(item) {
    state.previewItem = item;
    state.previewRequestId += 1;
    const requestId = state.previewRequestId;
    elements.previewImage.hidden = true;
    elements.previewSpinner.hidden = false;
    elements.previewCaption.textContent = item.name || "";
    elements.imagePreviewModal.classList.add("open");
    elements.imagePreviewModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    try {
      let blob;
      if (item.thumbnailLink && getActiveProviderId() === "google") {
        try {
          const response = await apiRequest(item.thumbnailLink.replace(/=s\d+$/, "=s800"));
          blob = await response.blob();
        } catch (_) {
          blob = await downloadFileBlob(item);
        }
      } else {
        blob = await downloadFileBlob(item);
      }
      if (requestId !== state.previewRequestId) return;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(blob);
      elements.previewImage.src = state.previewUrl;
      elements.previewImage.alt = item.name || "";
      elements.previewImage.hidden = false;
      elements.previewSpinner.hidden = true;
    } catch (error) {
      if (requestId !== state.previewRequestId) return;
      closeImagePreview(false);
      showToast("無法預覽：「" + (item.name || "") + "」" + (error.message ? " — " + error.message : ""), "error", 4000);
    }
  }

  function closeImagePreview(clearItem = true) {
    elements.imagePreviewModal.classList.remove("open");
    elements.imagePreviewModal.setAttribute("aria-hidden", "true");
    if (!$(".modal-backdrop.open")) document.body.classList.remove("modal-open");
    if (clearItem) {
      state.previewItem = null;
      state.previewRequestId += 1;
      if (state.previewUrl) {
        URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = null;
      }
      elements.previewImage.removeAttribute("src");
      elements.previewImage.hidden = true;
    }
  }

  function updateUploadProgress(fileName, percent, detail) {
    elements.uploadProgress.hidden = false;
    elements.uploadProgressName.textContent = fileName;
    elements.uploadProgressPercent.textContent = Math.round(percent) + "%";
    elements.uploadProgressBar.value = Math.round(percent);
    elements.uploadProgressDetail.textContent = detail || "";
  }

  function setUploadControlsDisabled(disabled) {
    state.uploadingFromModal = disabled;
    elements.confirmUploadButton.disabled = disabled || selectedFiles.length === 0;
    elements.dropzone.disabled = disabled;
    $("#cancelUploadButton").disabled = disabled;
  }

  async function uploadSelectedFiles(files) {
    if (state.isUploading) {
      showToast("另一個檔案仍在上傳，請完成後再開始。", "info");
      return;
    }
    state.isUploading = true;
    setUploadControlsDisabled(true);
    try {
      for (const file of files) {
        updateUploadProgress(file.name, 0, "連線至 " + getConfig().label + "…");
        await uploadFile(file, state.folderId, (percent, detail) => {
          updateUploadProgress(file.name, percent, detail);
        });
        showToast("「" + file.name + "」已上傳至 " + getConfig().label + "。");
      }
      closeUploadModal();
      await loadFiles();
    } catch (error) {
      console.error("上傳失敗:", error);
      showToast("上傳失敗：" + error.message, "error", 4500);
    } finally {
      state.isUploading = false;
      setUploadControlsDisabled(false);
      elements.uploadProgress.hidden = true;
    }
  }

  async function uploadQueuedItems() {
    if (state.isUploading || !state.account || !navigator.onLine) return;
    let queued;
    try {
      queued = await getQueuedUploads();
    } catch (error) {
      console.error("讀取離線上傳佇列失敗:", error);
      return;
    }
    if (!queued.length) {
      state.pending = [];
      renderFiles();
      return;
    }
    state.isUploading = true;
    state.pending = queued;
    renderFiles();
    try {
      for (const upload of queued) {
        try {
          const queuedBlob = upload.blob;
          const queuedFile = queuedBlob.name
            ? queuedBlob
            : new File([queuedBlob], upload.name, {
              type: upload.type || "application/octet-stream",
              lastModified: upload.lastModified || upload.queuedAt
            });
          await uploadFile(queuedFile, upload.folderId, (percent, detail) => {
            elements.overviewSync.textContent = "上傳 " + Math.round(percent) + "%";
            elements.overviewSyncCaption.textContent = detail;
          });
          await removeQueuedUpload(upload.id);
          state.pending = state.pending.filter((file) => file.id !== upload.id);
          showToast("「" + upload.name + "」已上傳至 " + getConfig().label + "。");
          renderFiles();
        } catch (error) {
          console.error("上傳檔案失敗:", upload.name, error);
          showToast("「" + upload.name + "」上傳失敗：" + error.message, "error", 4500);
          if (error.message.includes("逾期") || error.message.includes("重新連結")) break;
        }
      }
      if (state.pending.length < queued.length) await loadFiles();
    } catch (error) {
      console.error("讀取離線上傳佇列失敗:", error);
      showToast("無法讀取本機上傳佇列：" + error.message, "error", 4000);
    } finally {
      state.isUploading = false;
      renderFiles();
    }
  }

  async function addFilesToQueue(files) {
    if (!files.length) return;
    const hasLargeFile = files.some((file) => file.size > SIMPLE_UPLOAD_LIMIT);
    if (hasLargeFile && (!state.account || !navigator.onLine)) {
      showToast("大檔案需先登入並保持網路連線，才能分段上傳。", "error", 4500);
      return;
    }
    if (state.account && navigator.onLine) {
      await uploadSelectedFiles(files);
      return;
    }
    try {
      let addedCount = 0;
      for (const file of files) {
        await addQueuedUpload(file, state.folderId);
        addedCount += 1;
      }
      if (addedCount === 0) return;
      state.pending = await getQueuedUploads();
      renderFiles();
      closeUploadModal();
      if (navigator.onLine && state.account) {
        showToast("檔案已加入安全上傳佇列。", "info", 2200);
        await uploadQueuedItems();
      } else if (!state.account) {
        showToast("檔案已保存在此裝置；登入後即可同步至 " + getConfig().label + "。", "info", 3500);
      } else {
        showToast("目前離線，檔案已安全排入佇列，連線後會自動上傳。", "info", 3500);
      }
    } catch (error) {
      console.error("加入本機上傳佇列失敗:", error);
      showToast("無法將檔案儲存在此裝置：" + error.message, "error", 4200);
    }
  }

  function openUploadModal() {
    selectedFiles = [];
    elements.filePicker.value = "";
    elements.uploadProgress.hidden = true;
    renderSelectedFiles();
    setUploadControlsDisabled(false);
    elements.uploadModal.classList.add("open");
    elements.uploadModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => $("#closeModalButton").focus(), 80);
  }

  function closeUploadModal() {
    if (state.uploadingFromModal) return;
    elements.uploadModal.classList.remove("open");
    elements.uploadModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function renderSelectedFiles() {
    elements.selectedFiles.replaceChildren();
    elements.selectedFiles.hidden = selectedFiles.length === 0;
    elements.confirmUploadButton.disabled = state.uploadingFromModal || selectedFiles.length === 0;
    selectedFiles.forEach((file) => {
      const row = document.createElement("div");
      const fileName = document.createElement("span");
      const fileSize = document.createElement("span");
      row.className = "selected-file";
      fileName.textContent = file.name;
      fileSize.textContent = formatBytes(file.size);
      row.append(fileName, fileSize);
      elements.selectedFiles.append(row);
    });
  }

  function updateConnection() {
    const online = navigator.onLine;
    const conn = $("#connectionDot");
    if (conn && conn.parentElement) conn.parentElement.classList.toggle("offline", !online);
    const connText = $("#connectionText");
    if (connText) connText.textContent = online ? "網路連線正常" : "離線模式";
    const onlineDot = $("#onlineDot");
    if (onlineDot && onlineDot.parentElement) onlineDot.parentElement.classList.toggle("offline", !online);
    const onlineLabel = $("#onlineLabel");
    if (onlineLabel) onlineLabel.textContent = online ? "線上" : "離線";
  }

  function setAuthStatus(kind) {
    authKind = kind;
    const chip = $("#accountChip");
    if (!chip) return;
    chip.classList.toggle("signed-in", kind === "ok");
    chip.classList.toggle("connecting", kind === "connecting");
    chip.classList.toggle("has-error", kind === "error");
    const statusEl = $("#chipStatus");
    if (statusEl) statusEl.textContent = { ok: "已登入", connecting: "連線中…", error: "連線失敗", out: "尚未登入" }[kind];
    const emailEl = $("#chipEmail");
    if (!emailEl) return;
    if (kind === "error") emailEl.textContent = "點此重試";
    else if (kind === "out") emailEl.textContent = "—";
    else if (state.account) emailEl.textContent = state.account.email || state.account.displayName || getConfig().shortLabel;
  }

  function readProfile() {
    try { return JSON.parse(localStorage.getItem(profileKey()) || "null"); } catch (_) { return null; }
  }

  function applyProfile(profile) {
    const displayName = profile.displayName || profile.email || getConfig().shortLabel + " 帳戶";
    state.account = { displayName, email: profile.email || "", picture: profile.picture || "" };
    const initial = displayName.trim().charAt(0).toUpperCase() || "U";
    const nameEl = $("#accountName");
    const emailEl = $("#accountEmail");
    const avatarEl = $("#accountAvatar");
    const chipAvatar = $("#chipAvatar");
    if (nameEl) nameEl.textContent = displayName;
    if (emailEl) emailEl.textContent = profile.email || "已登入 " + getConfig().label;
    if (avatarEl) avatarEl.textContent = initial;
    if (chipAvatar) chipAvatar.textContent = initial;
    if (authKind !== "ok" && authKind !== "error") setAuthStatus("connecting");
    else setAuthStatus(authKind);
    const chip = $("#accountChip");
    if (chip) chip.title = profile.email || displayName;
  }

  function clearProfileUI() {
    const nameEl = $("#accountName");
    const emailEl = $("#accountEmail");
    const avatarEl = $("#accountAvatar");
    const chipAvatar = $("#chipAvatar");
    if (nameEl) nameEl.textContent = "尚未登入";
    if (emailEl) emailEl.textContent = "連結雲端帳戶";
    if (avatarEl) avatarEl.textContent = "?";
    if (chipAvatar) chipAvatar.textContent = "?";
    setAuthStatus("out");
    const chip = $("#accountChip");
    if (chip) chip.title = "尚未登入";
  }

  async function fetchProfile() {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 10000);
      let profile;
      try {
        profile = await fetchUserProfile();
      } finally {
        window.clearTimeout(timer);
      }
      try { localStorage.setItem(profileKey(), JSON.stringify(profile)); } catch (_) {}
      profileOk = true;
      if (state.account) applyProfile(profile);
    } catch (error) {
      console.warn("無法載入帳戶資料:", error);
    }
  }

  async function showAccount(account) {
    applyProfile(readProfile() || account);
    renderFiles();
    profileOk = false;
    setAuthStatus("connecting");
    const profileTask = fetchProfile();
    await loadFiles();
    await profileTask;
    if (!profileOk && authKind === "ok") await fetchProfile();
    await uploadQueuedItems();
  }

  async function completeExternalSignIn() {
    if (state.account) return;
    const tokens = getTokens();
    if (!tokens.accessToken && !tokens.refreshToken) return;
    showToast(getConfig().shortLabel + " 帳戶已成功連結。");
    await showAccount({ displayName: getConfig().shortLabel + " 帳戶" });
  }

  function confirmSignOut() {
    if ($("#signOutModal")) return;
    const config = getConfig();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.id = "signOutModal";
    backdrop.setAttribute("aria-hidden", "false");
    backdrop.innerHTML = '<section class="modal glass signout-modal" role="dialog" aria-modal="true" aria-labelledby="signOutTitle">' +
      '<h2 id="signOutTitle">要登出 ' + config.shortLabel + ' 嗎？</h2>' +
      '<p class="modal-description" id="signOutDesc"></p>' +
      '<div class="modal-actions"><button class="button button-quiet" type="button" data-act="cancel">保持登入</button>' +
      '<button class="button button-danger" type="button" data-act="ok">登出</button></div></section>';
    backdrop.querySelector("#signOutDesc").textContent =
      "目前登入：" + ((state.account && (state.account.email || state.account.displayName)) || config.shortLabel) +
      "。登出後需要重新登入才能存取檔案。";
    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      if (!$(".modal-backdrop.open")) document.body.classList.remove("modal-open");
    };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) { close(); return; }
      const act = event.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "ok") signOut();
      close();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.classList.add("modal-open");
    document.body.append(backdrop);
    backdrop.querySelector('[data-act="cancel"]').focus();
  }

  async function signOut() {
    clearTokens();
    try { localStorage.removeItem(profileKey()); } catch (_) {}
    state.account = null;
    state.loadError = "";
    profileOk = false;
    state.items = [];
    state.folderId = null;
    state.folderName = "";
    clearProfileUI();
    renderFiles();
    showToast("已從此裝置登出 " + getConfig().shortLabel + " 帳戶。", "info");
  }

  function setView(view) {
    state.view = view;
    state.filter = view === "folders" ? "folders" : "all";
    state.folderId = null;
    state.folderName = "";
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });
    document.querySelectorAll(".pill-tab").forEach((button) => {
      const active = button.dataset.filter === state.filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    loadFiles();
  }

  async function switchProvider(providerId) {
    if (!CLOUD.providers[providerId] || providerId === getActiveProviderId()) return;
    // 切換前先清空目前畫面狀態（token 各自獨立保存）
    state.account = null;
    state.items = [];
    state.pending = [];
    state.folderId = null;
    state.folderName = "";
    state.loadError = "";
    profileOk = false;
    preparedAuthRequest = null;
    setActiveProviderId(providerId);
    updateProviderSwitcherUI();
    clearProfileUI();
    renderFiles();
    prepareAuthorizationRequest();
    try {
      state.pending = await getQueuedUploads();
    } catch (_) {
      state.pending = [];
    }
    const tokens = getTokens();
    if (tokens.accessToken || tokens.refreshToken) {
      await showAccount({ displayName: getConfig().shortLabel + " 帳戶" });
    } else {
      renderFiles();
      showToast("已切換至 " + getConfig().label + "。請登入此雲端帳戶。", "info", 3200);
    }
  }

  function updateProviderSwitcherUI() {
    const active = getActiveProviderId();
    document.querySelectorAll("[data-provider]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.provider === active);
    });
    const config = getConfig();
    const brandSmall = document.querySelector(".brand-copy small");
    if (brandSmall) brandSmall.textContent = config.brand;
    const storageStrong = document.querySelector(".storage-heading strong");
    if (storageStrong) storageStrong.textContent = config.label;
  }

  function bindEvents() {
    window.addEventListener("storage", (event) => {
      if (event.key && event.key.startsWith("cloud.oauth.tokens.") && event.newValue) {
        completeExternalSignIn();
      }
    });
    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || !event.data || event.data.source !== "cloud-pwa-auth") return;
      if (event.data.error) {
        showToast(event.data.error, "error", 4500);
        return;
      }
      const receivedTokens = event.data.tokens;
      if (receivedTokens && receivedTokens.accessToken) {
        try { setTokens(receivedTokens); } catch (error) {
          showToast("登入已完成，但無法儲存帳戶狀態。", "error", 5000);
          return;
        }
      }
      completeExternalSignIn();
    });

    document.querySelectorAll("[data-provider]").forEach((button) => {
      button.addEventListener("click", () => switchProvider(button.dataset.provider));
    });

    $("#accountButton").addEventListener("click", () => state.account ? confirmSignOut() : signIn());
    $("#mobileAccountButton").addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
      state.account ? confirmSignOut() : signIn();
    });
    $("#accountChip").addEventListener("click", () => {
      if (!state.account) return signIn();
      if (authKind === "error") { loadFiles(); fetchProfile(); return; }
      confirmSignOut();
    });
    $("#emptyAction").addEventListener("click", () => state.account ? (state.loadError ? loadFiles() : openUploadModal()) : signIn());
    $("#topUploadButton").addEventListener("click", openUploadModal);
    $("#mobileUploadButton").addEventListener("click", openUploadModal);
    $("#refreshButton").addEventListener("click", () => loadFiles());
    $("#menuButton").addEventListener("click", () => document.body.classList.add("sidebar-open"));
    $("#sidebarBackdrop").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        setView(button.dataset.view);
        document.body.classList.remove("sidebar-open");
      });
    });
    document.querySelectorAll(".pill-tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        if (state.filter !== "folders") state.view = "all";
        document.querySelectorAll(".pill-tab").forEach((tab) => {
          const active = tab === button;
          tab.classList.toggle("active", active);
          tab.setAttribute("aria-selected", String(active));
        });
        renderFiles();
      });
    });
    $("#sortButton").addEventListener("click", () => {
      state.sortAscending = !state.sortAscending;
      $("#sortButton span").textContent = state.sortAscending ? "名稱排序" : "名稱反向";
      renderFiles();
    });
    elements.searchInput.addEventListener("input", renderFiles);
    elements.breadcrumbCurrent.addEventListener("click", () => {
      if (!state.folderId) return;
      state.folderId = null;
      state.folderName = "";
      loadFiles();
    });
    elements.breadcrumbCurrent.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && state.folderId) {
        state.folderId = null;
        state.folderName = "";
        loadFiles();
      }
    });
    $("#dropzone").addEventListener("click", () => elements.filePicker.click());
    elements.filePicker.addEventListener("change", () => {
      selectedFiles = Array.from(elements.filePicker.files || []);
      renderSelectedFiles();
    });
    elements.confirmUploadButton.addEventListener("click", () => addFilesToQueue(selectedFiles.slice()));
    $("#closeModalButton").addEventListener("click", closeUploadModal);
    $("#cancelUploadButton").addEventListener("click", closeUploadModal);
    elements.uploadModal.addEventListener("click", (event) => {
      if (event.target === elements.uploadModal) closeUploadModal();
    });
    $("#closePreviewButton").addEventListener("click", () => closeImagePreview());
    $("#previewDownloadButton").addEventListener("click", () => {
      if (state.previewItem) downloadFile(state.previewItem);
    });
    elements.imagePreviewModal.addEventListener("click", (event) => {
      if (event.target === elements.imagePreviewModal) closeImagePreview();
    });
    elements.dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("drag-over");
    });
    elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("drag-over"));
    elements.dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("drag-over");
      selectedFiles = Array.from(event.dataTransfer.files || []);
      renderSelectedFiles();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeUploadModal();
        closeImagePreview();
        document.body.classList.remove("sidebar-open");
      }
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        elements.searchInput.focus();
      }
    });
    window.addEventListener("online", () => {
      updateConnection();
      showToast("網路已恢復，正在同步待上傳檔案。", "info");
      loadFiles();
      uploadQueuedItems();
    });
    window.addEventListener("offline", () => {
      updateConnection();
      showToast("已切換至離線模式，已快取的檔案清單仍可瀏覽。", "info");
      loadFiles({ cachedOnly: true });
    });
    window.addEventListener("focus", () => {
      if (!state.account) {
        const tokens = getTokens();
        if (tokens.accessToken || tokens.refreshToken) completeExternalSignIn();
      }
    });
    const recover = () => {
      if (!state.account || state.isLoading || state.isUploading || !navigator.onLine) return;
      if (Date.now() - lastLoadAt < 3000) return;
      if (state.loadError || (authKind !== "ok") || state.items.length === 0) {
        loadFiles();
        if (!profileOk) fetchProfile();
      }
    };
    window.setInterval(() => {
      if (state.account && authKind === "connecting" && !state.isLoading) recover();
    }, 4000);
    window.addEventListener("online", () => window.setTimeout(recover, 800));
    window.addEventListener("pageshow", recover);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recover();
      if (document.visibilityState === "visible" && !state.account) {
        const tokens = getTokens();
        if (tokens.accessToken || tokens.refreshToken) completeExternalSignIn();
      }
    });
  }

  async function initialize() {
    bindEvents();
    updateConnection();
    updateProviderSwitcherUI();
    clearExpiredAuthFlow();
    const sharedFiles = new URLSearchParams(window.location.search).get("shared") === "1";
    if (sharedFiles) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    const callbackParams = new URLSearchParams(window.location.search);
    const hasOAuthCallback = callbackParams.has("code") || callbackParams.has("error");
    let completedLogin = false;
    let callbackError = null;
    if (hasOAuthCallback) {
      try {
        completedLogin = await exchangeAuthorizationCode();
      } catch (error) {
        callbackError = error;
        console.error("OAuth 登入失敗:", error);
      }
      if (window.opener && window.opener !== window) {
        try {
          window.opener.postMessage({
            source: "cloud-pwa-auth",
            error: callbackError ? callbackError.message : null,
            tokens: callbackError ? null : getTokens()
          }, window.location.origin);
        } catch (error) {
          console.warn("無法通知原本的 App 登入結果:", error);
        }
        window.close();
        return;
      }
      if (callbackError) {
        showToast(callbackError.message || "登入失敗。", "error", 4500);
      }
    }

    try {
      state.pending = await getQueuedUploads();
    } catch (error) {
      console.error("無法載入待上傳檔案:", error);
    }

    const tokens = getTokens();
    if (sharedFiles) {
      showToast(tokens.accessToken || tokens.refreshToken
        ? "已收到分享檔案，正在準備上傳。"
        : "已收到分享檔案；登入後會上傳。", "info", 3500);
    }
    if (tokens.accessToken || tokens.refreshToken) {
      await showAccount({ displayName: getConfig().shortLabel + " 帳戶" });
      if (completedLogin) showToast(getConfig().shortLabel + " 帳戶已成功連結。");
    } else {
      renderFiles();
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.error("Service Worker 註冊失敗:", error);
        showToast("離線快取無法啟用：" + error.message, "error", 4000);
      });
    }
  }

  prepareAuthorizationRequest();
  initialize();
})();
