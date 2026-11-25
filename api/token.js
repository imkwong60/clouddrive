/**
 * Vercel Serverless: OAuth token exchange / refresh for Google & Microsoft.
 *
 * 環境變數（Vercel → Settings → Environment Variables）：
 *   GOOGLE_CLIENT_ID       （可選，預設用下方 clientId）
 *   GOOGLE_CLIENT_SECRET   （若 Google 應用程式類型為 Web 且有 secret）
 *   MS_CLIENT_ID           （可選，預設用下方 clientId）
 *   MS_CLIENT_SECRET       （必要：Azure 應用程式密碼）
 *   ALLOWED_ORIGIN         （可選，逗號分隔；預設已含 https://imkwong60.github.io）
 *
 * 請求 body (application/x-www-form-urlencoded 或 JSON)：
 *   provider=google|microsoft
 *   grant_type=authorization_code|refresh_token
 *   code / code_verifier / redirect_uri  （authorization_code）
 *   refresh_token                        （refresh_token）
 */

const PROVIDERS = {
  google: {
    clientId:
      process.env.GOOGLE_CLIENT_ID ||
      "978083976906-oicde1ab0nnd9d3q1v4hifialbqd3a8g.apps.googleusercontent.com",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    tokenUrl: "https://oauth2.googleapis.com/token"
  },
  microsoft: {
    clientId:
      process.env.MS_CLIENT_ID ||
      "7fe6bd89-67dd-4255-a1fd-cc52d369f2df",
    clientSecret: process.env.MS_CLIENT_SECRET || "",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token"
  }
};

function corsHeaders(origin) {
  // 前端在 GitHub Pages，API 在 Vercel：必須明確允許跨域
  const defaults = [
    "https://imkwong60.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173"
  ];
  const envAllow = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set([...defaults, ...envAllow]);
  // 有列出 origin 就回該 origin（瀏覽器要求不能用 * 搭配 credentials；我們不用 credentials）
  const allow =
    origin && (allowed.has(origin) || envAllow.includes("*") || allowed.has("*"))
      ? origin
      : envAllow[0] || defaults[0] || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      /* fall through */
    }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  try {
    const body = parseBody(req);
    const providerKey = String(body.provider || "google").toLowerCase();
    const provider = PROVIDERS[providerKey];
    if (!provider) {
      res.writeHead(400, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown_provider", error_description: "provider must be google or microsoft" }));
      return;
    }

    if (providerKey === "microsoft" && !provider.clientSecret) {
      res.writeHead(500, { ...headers, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "server_misconfigured",
          error_description: "MS_CLIENT_SECRET is not set on the server"
        })
      );
      return;
    }

    const grantType = body.grant_type || "authorization_code";
    const form = new URLSearchParams();
    form.set("client_id", provider.clientId);
    form.set("grant_type", grantType);

    if (provider.clientSecret) {
      form.set("client_secret", provider.clientSecret);
    }

    if (grantType === "authorization_code") {
      if (!body.code) {
        res.writeHead(400, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "code is required" }));
        return;
      }
      form.set("code", body.code);
      form.set("redirect_uri", body.redirect_uri || "");
      if (body.code_verifier) form.set("code_verifier", body.code_verifier);
      // Microsoft 建議在 token 請求也帶 scope（可選）
      if (body.scope) form.set("scope", body.scope);
    } else if (grantType === "refresh_token") {
      if (!body.refresh_token) {
        res.writeHead(400, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "refresh_token is required" }));
        return;
      }
      form.set("refresh_token", body.refresh_token);
      if (body.scope) form.set("scope", body.scope);
    } else {
      res.writeHead(400, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    const upstream = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = { error: "invalid_upstream_response", error_description: text.slice(0, 200) };
    }

    res.writeHead(upstream.status, {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error("token proxy error:", error);
    res.writeHead(500, { ...headers, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "server_error",
        error_description: error.message || "Unexpected error"
      })
    );
  }
};
