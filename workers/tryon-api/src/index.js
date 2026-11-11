// Sugar Nail 試甲 API — Cloudflare Worker（免費層）
// 職責：登入核對、每日限額計數、店主查用量／重設、記錄申請。
// 唔做：唔生成圖片、唔存相片、申請本身由靜態頁經 WhatsApp 傳去店舖。
// 密碼永遠唔會出現喺呢個檔案：核對值嚟自 Worker secrets
// GUEST_PASSWORD_HASH / ADMIN_PASSWORD_HASH（SHA-256 hex）。

const DAILY_LIMIT = 3;
const PACKAGE_TOTAL = 6; /* Pass2U 美甲套票（Model 380564）總共 6 次 */
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 小時
const LOGIN_MAX_FAILS = 10; // 每 IP 每 10 分鐘最多 10 次失敗登入
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// 香港日期（YYYY-MM-DD），每日限額按香港日計。
function hkDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function passUrlFromPassId(passId) {
  return "https://www.pass2u.net/d/" + encodeURIComponent(passId) + "?t=qr_code&openExternalBrowser=1";
}

function clampUsed(v) {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(PACKAGE_TOTAL, n));
}

function normaliseQr(qr) {
  return String(qr ?? "").trim().toLowerCase();
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 固定時間比較，避免 timing attack。兩個 hex 字串長度唔同即唔等。
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPassword(password, expectedHash) {
  if (typeof password !== "string" || password.length === 0) return false;
  if (!expectedHash) return false;
  const hash = await sha256Hex(password);
  return timingSafeEqual(hash, expectedHash);
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getSession(env, token) {
  if (!token) return null;
  const raw = await env.TRYON_KV.get(`session:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function createSession(env, data) {
  const token = randomHex(32);
  await env.TRYON_KV.put(`session:${token}`, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ---------------- 帳戶（店主管理） ----------------
// 帳戶記錄放喺 KV：key `acct:<qr>`，內容 {qr, name, status, createdAt, updatedAt}。
// status：active（正常）／disabled（停用）／void（已作廢）。
// 未登記嘅 QR 照樣登入到（沿用共用密碼制）；有記錄而狀態唔係 active 先會擋登入。
const ACCOUNT_STATUSES = ["active", "disabled", "void"];

function acctKey(qr) {
  return `acct:${qr}`;
}

async function getAccount(env, qr) {
  const raw = await env.TRYON_KV.get(acctKey(qr));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putAccount(env, account) {
  await env.TRYON_KV.put(acctKey(account.qr), JSON.stringify(account));
}

async function listAccounts(env) {
  const list = await env.TRYON_KV.list({ prefix: "acct:" });
  const rows = [];
  for (const item of list.keys) {
    const raw = await env.TRYON_KV.get(item.name);
    if (!raw) continue;
    try {
      rows.push(JSON.parse(raw));
    } catch {
      // 壞記錄跳過
    }
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

async function getUsed(env, date, qr) {
  const raw = await env.TRYON_KV.get(`quota:${date}:${qr}`);
  const n = raw === null ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 輕量登入限速：每 IP 每 10 分鐘最多 10 次失敗，之後回 429。
// 成功登入會清走計數。
async function loginRateLimited(env, ip) {
  const key = `ratelimit:${ip}`;
  const raw = await env.TRYON_KV.get(key);
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw);
    if (Date.now() > rec.resetAt) return false;
    return rec.fails >= LOGIN_MAX_FAILS;
  } catch {
    return false;
  }
}

async function recordFailedLogin(env, ip) {
  const key = `ratelimit:${ip}`;
  const raw = await env.TRYON_KV.get(key);
  let rec = { fails: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
  if (raw) {
    try {
      const old = JSON.parse(raw);
      if (Date.now() <= old.resetAt) rec = old;
    } catch {
      // 舊記錄壞咗就由頭計
    }
  }
  rec.fails += 1;
  const ttl = Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000));
  await env.TRYON_KV.put(key, JSON.stringify(rec), { expirationTtl: ttl });
}

async function clearFailedLogins(env, ip) {
  await env.TRYON_KV.delete(`ratelimit:${ip}`);
}

// ---------------- 客人 ----------------

async function handleLogin(request, env) {
  const ip = clientIp(request);
  if (await loginRateLimited(env, ip)) {
    return json(
      { ok: false, error: "嘗試太多次，請 10 分鐘後再試" },
      429,
    );
  }
  const body = await readJson(request);
  const qr = normaliseQr(body?.qr);
  const password = body?.password;
  if (!qr || typeof password !== "string") {
    return json({ ok: false, error: "請輸入登入 ID 同密碼" }, 400);
  }

  const unlimited = qr === "test";
  const good = await verifyPassword(password, env.GUEST_PASSWORD_HASH);
  if (!good) {
    await recordFailedLogin(env, ip);
    return json({ ok: false, error: "密碼唔啱" }, 401);
  }
  await clearFailedLogins(env, ip);

  // 有帳戶記錄而狀態唔係正常：停用／作廢都唔俾登入。
  const account = unlimited ? null : await getAccount(env, qr);
  if (account && account.status === "disabled") {
    return json({ ok: false, error: "呢個帳戶已停用，請聯絡店主" }, 403);
  }
  if (account && account.status === "void") {
    return json({ ok: false, error: "呢個帳戶已作廢，請聯絡店主" }, 403);
  }

  const token = await createSession(env, {
    qr,
    unlimited,
    created: Date.now(),
  });
  const used = unlimited ? 0 : await getUsed(env, hkDate(), qr);
  return json({
    ok: true,
    token,
    unlimited,
    remaining: unlimited ? null : Math.max(0, DAILY_LIMIT - used),
    name: account?.name || "",
    passUrl: account?.passUrl || "",
    sessionsUsed: account ? (account.used || 0) : null,
    sessionsLeft: account ? Math.max(0, PACKAGE_TOTAL - (account.used || 0)) : null,
  });
}

async function handleQuota(request, env) {
  const body = await readJson(request);
  const session = await getSession(env, body?.token);
  if (!session || session.admin) {
    return json({ ok: false, error: "登入已失效，請重新登入" }, 401);
  }
  if (session.unlimited) {
    return json({ ok: true, remaining: null, unlimited: true });
  }
  const used = await getUsed(env, hkDate(), session.qr);
  return json({
    ok: true,
    remaining: Math.max(0, DAILY_LIMIT - used),
    unlimited: false,
  });
}

async function handleSubmit(request, env) {
  const body = await readJson(request);
  const session = await getSession(env, body?.token);
  if (!session || session.admin) {
    return json({ ok: false, error: "登入已失效，請重新登入" }, 401);
  }
  const design = typeof body?.design === "string" ? body.design.trim() : "";
  if (!design) {
    return json({ ok: false, error: "請揀一個款式" }, 400);
  }

  const date = hkDate();
  if (!session.unlimited) {
    const used = await getUsed(env, date, session.qr);
    if (used >= DAILY_LIMIT) {
      return json({ ok: false, error: "今日額滿" }, 403);
    }
    // KV 讀改寫：單一 Worker 實例、每日 3 次嘅量，夠用。
    await env.TRYON_KV.put(`quota:${date}:${session.qr}`, String(used + 1));
  }

  const ts = Date.now();
  const key = `req:${date}:${ts}-${randomHex(4)}`;
  await env.TRYON_KV.put(
    key,
    JSON.stringify({ qr: session.qr, design, ts }),
  );

  const used = session.unlimited
    ? 0
    : await getUsed(env, date, session.qr);
  return json({
    ok: true,
    remaining: session.unlimited ? null : Math.max(0, DAILY_LIMIT - used),
    unlimited: session.unlimited,
  });
}

// ---------------- 店主 ----------------

async function handleAdminLogin(request, env) {
  const ip = clientIp(request);
  if (await loginRateLimited(env, ip)) {
    return json(
      { ok: false, error: "嘗試太多次，請 10 分鐘後再試" },
      429,
    );
  }
  const body = await readJson(request);
  const good = await verifyPassword(body?.password, env.ADMIN_PASSWORD_HASH);
  if (!good) {
    await recordFailedLogin(env, ip);
    return json({ ok: false, error: "密碼唔啱" }, 401);
  }
  await clearFailedLogins(env, ip);
  const token = await createSession(env, { admin: true, created: Date.now() });
  return json({ ok: true, token });
}

async function requireAdmin(request, env) {
  const session = await getSession(env, bearerToken(request));
  return session && session.admin ? session : null;
}

async function handleAdminUsage(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const date = hkDate();
  const prefix = `quota:${date}:`;
  const list = await env.TRYON_KV.list({ prefix });
  const rows = [];
  for (const item of list.keys) {
    const qr = item.name.slice(prefix.length);
    const used = await getUsed(env, date, qr);
    const account = await getAccount(env, qr);
    rows.push({
      qr,
      name: account?.name || "",
      used,
      remaining: Math.max(0, DAILY_LIMIT - used),
    });
  }
  rows.sort((a, b) => b.used - a.used || a.qr.localeCompare(b.qr));
  return json({ ok: true, date, usage: rows });
}

async function handleAdminReset(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const qr = normaliseQr(body?.qr);
  if (!qr) {
    return json({ ok: false, error: "請提供要重設嘅登入 ID" }, 400);
  }
  await env.TRYON_KV.delete(`quota:${hkDate()}:${qr}`);
  return json({ ok: true, qr, remaining: DAILY_LIMIT });
}

async function handleAdminRequests(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const date = hkDate();
  const prefix = `req:${date}:`;
  const list = await env.TRYON_KV.list({ prefix, limit: 100 });
  const rows = [];
  for (const item of list.keys) {
    const raw = await env.TRYON_KV.get(item.name);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      const account = await getAccount(env, rec.qr);
      rec.name = account?.name || "";
      rows.push(rec);
    } catch {
      // 壞記錄跳過
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  return json({ ok: true, date, requests: rows.slice(0, 100) });
}

// ---------------- 帳戶管理（店主） ----------------

async function handleAdminAccountsList(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const date = hkDate();
  const accounts = await listAccounts(env);
  const rows = [];
  for (const a of accounts) {
    const used = await getUsed(env, date, a.qr);
    rows.push({
      qr: a.qr,
      name: a.name || "",
      passUrl: a.passUrl || "",
      sessionsUsed: a.used || 0,
      sessionsLeft: Math.max(0, PACKAGE_TOTAL - (a.used || 0)),
      status: a.status || "active",
      createdAt: a.createdAt || 0,
      used,
      remaining: Math.max(0, DAILY_LIMIT - used),
    });
  }
  return json({ ok: true, accounts: rows });
}

async function handleAdminAccountsCreate(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const qr = normaliseQr(body?.qr);
  if (!qr) {
    return json({ ok: false, error: "請提供登入 ID（QR Code 內容）" }, 400);
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  let passUrl = typeof body?.passUrl === "string" ? body.passUrl.trim() : "";
  const passId = typeof body?.passId === "string" ? body.passId.trim() : "";
  if (!passUrl && passId) passUrl = passUrlFromPassId(passId);
  const used = clampUsed(body?.used);
  const existing = await getAccount(env, qr);
  if (existing) {
    return json({ ok: true, account: existing, existed: true });
  }
  const now = Date.now();
  const account = { qr, name, passUrl, used, status: "active", createdAt: now, updatedAt: now };
  await putAccount(env, account);
  return json({ ok: true, account, existed: false });
}

async function handleAdminAccountsUpdate(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const qr = normaliseQr(body?.qr);
  if (!qr) {
    return json({ ok: false, error: "請提供登入 ID（QR Code 內容）" }, 400);
  }
  const account = await getAccount(env, qr);
  if (!account) {
    return json({ ok: false, error: "搵唔到呢個帳戶" }, 404);
  }
  if (typeof body?.name === "string") account.name = body.name.trim();
  if (typeof body?.passUrl === "string") account.passUrl = body.passUrl.trim();
  if (typeof body?.passId === "string" && body.passId.trim() && !body.passUrl) account.passUrl = passUrlFromPassId(body.passId.trim());
  if (body?.used !== undefined) account.used = clampUsed(body.used);
  if (typeof body?.status === "string") {
    if (!ACCOUNT_STATUSES.includes(body.status)) {
      return json({ ok: false, error: "狀態唔啱" }, 400);
    }
    account.status = body.status;
  }
  account.updatedAt = Date.now();
  await putAccount(env, account);
  return json({ ok: true, account });
}

async function handleAdminAccountsDelete(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const qr = normaliseQr(body?.qr);
  if (!qr) {
    return json({ ok: false, error: "請提供登入 ID（QR Code 內容）" }, 400);
  }
  await env.TRYON_KV.delete(acctKey(qr));
  return json({ ok: true, qr });
}

async function handleAdminAccountsImport(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 500) : [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const qr = normaliseQr(row?.qr);
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    let passUrl = typeof row?.passUrl === "string" ? row.passUrl.trim() : "";
    const passId = typeof row?.passId === "string" ? row.passId.trim() : "";
    if (!passUrl && passId) passUrl = passUrlFromPassId(passId);
    const used = row?.used === undefined ? null : clampUsed(row.used);
    if (!qr) {
      skipped++;
      continue;
    }
    const existing = await getAccount(env, qr);
    const now = Date.now();
    if (existing) {
      if (name || passUrl || used !== null) {
        if (name) existing.name = name;
        if (passUrl) existing.passUrl = passUrl;
        if (used !== null) existing.used = used;
        existing.updatedAt = now;
        await putAccount(env, existing);
        updated++;
      } else {
        skipped++;
      }
    } else {
      await putAccount(env, { qr, name, passUrl, used: used ?? 0, status: "active", createdAt: now, updatedAt: now });
      created++;
    }
  }
  return json({ ok: true, created, updated, skipped });
}

// ---------------- 路由 ----------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/api/health" && request.method === "GET") {
      return json({ ok: true });
    }
    if (path === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (path === "/api/quota" && request.method === "POST") {
      return handleQuota(request, env);
    }
    if (path === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }
    if (path === "/api/admin/login" && request.method === "POST") {
      return handleAdminLogin(request, env);
    }
    if (path === "/api/admin/usage" && request.method === "GET") {
      return handleAdminUsage(request, env);
    }
    if (path === "/api/admin/reset" && request.method === "POST") {
      return handleAdminReset(request, env);
    }
    if (path === "/api/admin/requests" && request.method === "GET") {
      return handleAdminRequests(request, env);
    }
    if (path === "/api/admin/accounts" && request.method === "GET") {
      return handleAdminAccountsList(request, env);
    }
    if (path === "/api/admin/accounts/create" && request.method === "POST") {
      return handleAdminAccountsCreate(request, env);
    }
    if (path === "/api/admin/accounts/update" && request.method === "POST") {
      return handleAdminAccountsUpdate(request, env);
    }
    if (path === "/api/admin/accounts/delete" && request.method === "POST") {
      return handleAdminAccountsDelete(request, env);
    }
    if (path === "/api/admin/accounts/import" && request.method === "POST") {
      return handleAdminAccountsImport(request, env);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
