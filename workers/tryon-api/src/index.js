// Sugar Nail 試甲 API — Cloudflare Worker（免費層）
// 職責：登入核對、每日限額計數、店主查用量／重設、記錄申請（連手相＋效果圖）。
// 唔做：唔生成圖片（效果圖由 Muse 喺對話入面生成，店主上傳返入嚟）。
// 申請記錄（手相＋效果圖）保留 7 日，過期唔會再出現，要用 cleanup 先會真正刪除。
// 密碼永遠唔會出現喺呢個檔案：核對值嚟自 Worker secrets
// GUEST_PASSWORD_HASH / ADMIN_PASSWORD_HASH（SHA-256 hex）。

const DAILY_LIMIT = 3;
const PACKAGE_TOTAL = 6; /* Pass2U 美甲套票（Model 380564）總共 6 次 */
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 小時
const LOGIN_MAX_FAILS = 10; // 每 IP 每 10 分鐘最多 10 次失敗登入
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 申請記錄保留 7 日（由提交時間起計）
const MAX_IMAGE_CHARS = 7000000; // 相片 data URL 上限：約 5MB（base64 長度計）

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

// 相片 data URL 檢查：只接受 JPEG／PNG，唔超過約 5MB。
function isDataUrlImage(v) {
  if (typeof v !== "string") return false;
  if (v.length > MAX_IMAGE_CHARS) return false;
  if (
    !v.startsWith("data:image/jpeg;base64,") &&
    !v.startsWith("data:image/png;base64,")
  ) {
    return false;
  }
  const payload = v.split(",", 2)[1] || "";
  return payload.length > 0;
}

function imageTooBig(v) {
  return typeof v === "string" && v.length > MAX_IMAGE_CHARS;
}

function isHttpsUrl(v) {
  return typeof v === "string" && v.startsWith("https://");
}

// ---------------- 申請記錄 ----------------
// key：`req:<香港日期>:<ts>-<隨機>`（沿用舊做法：日期前綴就係索引，唔另設索引 key）。
// 值：{id, qr, name, design, designLink, handPhoto, refPhoto, status, resultUrl, resultImage, createdAt, ts}。
// refPhoto：客人自備參考相（data URL，冇就 null）。
// status：pending（等緊生成）／done（已完成）。記錄由 createdAt 起計保留 7 日。
function requestDateStrings() {
  // 今日起計過去 8 個香港曆日（覆蓋晒 7 日保留期內嘅記錄）。
  const days = [];
  for (let i = 0; i < 8; i++) {
    const d = hkDate(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    if (!days.includes(d)) days.push(d);
  }
  return days;
}

async function listAllKeys(env, prefix) {
  let keys = [];
  let cursor;
  do {
    const res = await env.TRYON_KV.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    keys = keys.concat(res.keys || []);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return keys;
}

async function loadRequest(env, key) {
  const raw = await env.TRYON_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 列出 7 日保留期內嘅申請記錄（最新先）。
async function listRecentRequests(env) {
  const cutoff = Date.now() - RETENTION_MS;
  const rows = [];
  for (const date of requestDateStrings()) {
    const list = await env.TRYON_KV.list({ prefix: `req:${date}:`, limit: 1000 });
    for (const item of list.keys) {
      const rec = await loadRequest(env, item.name);
      if (!rec) continue;
      const at = rec.createdAt || rec.ts || 0;
      if (at < cutoff) continue;
      rows.push(rec);
    }
  }
  rows.sort((a, b) => (b.createdAt || b.ts || 0) - (a.createdAt || a.ts || 0));
  return rows;
}

// 用 id 搵申請記錄（逐個 key 對，呢個量級夠用）。
async function findRequest(env, id) {
  const keys = await listAllKeys(env, "req:");
  for (const item of keys) {
    const rec = await loadRequest(env, item.name);
    if (rec && rec.id === id) return { key: item.name, rec };
  }
  return null;
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
  const designLink = typeof body?.designLink === "string" ? body.designLink.trim() : "";
  if (designLink && !isHttpsUrl(designLink)) {
    return json({ ok: false, error: "作品連結唔啱" }, 400);
  }
  const handPhoto = body?.handPhoto;
  if (typeof handPhoto !== "string" || !handPhoto) {
    return json({ ok: false, error: "請上傳你隻手嘅相" }, 400);
  }
  if (imageTooBig(handPhoto)) {
    return json({ ok: false, error: "相太大，請重新上傳一張細啲嘅相" }, 400);
  }
  if (!isDataUrlImage(handPhoto)) {
    return json({ ok: false, error: "手相格式唔啱，請重新上傳" }, 400);
  }
  // 自備參考相（可選）：揀咗 181 款嗰陣唔傳；上傳咗先會跟埋申請一齊傳去。
  const refPhotoRaw = body?.refPhoto;
  let refPhoto = null;
  if (refPhotoRaw !== undefined && refPhotoRaw !== null && refPhotoRaw !== "") {
    if (typeof refPhotoRaw !== "string") {
      return json({ ok: false, error: "參考相格式唔啱，請重新上傳" }, 400);
    }
    if (imageTooBig(refPhotoRaw)) {
      return json({ ok: false, error: "參考相太大，請重新上傳一張細啲嘅相" }, 400);
    }
    if (!isDataUrlImage(refPhotoRaw)) {
      return json({ ok: false, error: "參考相格式唔啱，請重新上傳" }, 400);
    }
    refPhoto = refPhotoRaw;
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
  const id = crypto.randomUUID();
  const key = `req:${date}:${ts}-${randomHex(4)}`;
  const account = await getAccount(env, session.qr);
  await env.TRYON_KV.put(
    key,
    JSON.stringify({
      id,
      qr: session.qr,
      name: account?.name || "",
      design,
      designLink,
      handPhoto,
      refPhoto,
      status: "pending",
      resultUrl: null,
      resultImage: null,
      createdAt: ts,
      ts,
    }),
  );

  const used = session.unlimited
    ? 0
    : await getUsed(env, date, session.qr);
  return json({
    ok: true,
    id,
    remaining: session.unlimited ? null : Math.max(0, DAILY_LIMIT - used),
    unlimited: session.unlimited,
  });
}

/* 客人睇自己 7 日內嘅申請（只回 metadata＋效果圖，唔回手相）。 */
async function handleMyRequests(request, env) {
  const session = await getSession(env, bearerToken(request));
  if (!session || session.admin) {
    return json({ ok: false, error: "登入已失效，請重新登入" }, 401);
  }
  const rows = await listRecentRequests(env);
  const mine = rows.filter((r) => r.qr === session.qr);
  return json({
    ok: true,
    requests: mine.map((r) => ({
      id: r.id || "",
      design: r.design || "",
      designLink: r.designLink || "",
      status: r.status || "pending",
      resultUrl: r.resultUrl || null,
      resultImage: r.resultImage || null,
      hasRefPhoto: !!r.refPhoto,
      createdAt: r.createdAt || r.ts || 0,
      ts: r.ts || r.createdAt || 0,
    })),
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

/* 店主睇最近 7 日嘅申請記錄（metadata only：唔回手相，效果圖只回「有冇」）。 */
async function handleAdminRequests(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const rows = await listRecentRequests(env);
  const out = [];
  for (const rec of rows) {
    const account = await getAccount(env, rec.qr);
    out.push({
      id: rec.id || "",
      qr: rec.qr || "",
      name: rec.name || account?.name || "",
      design: rec.design || "",
      designLink: rec.designLink || "",
      status: rec.status || "pending",
      resultUrl: rec.resultUrl || null,
      hasResultImage: !!rec.resultImage,
      hasResult: !!(rec.resultImage || rec.resultUrl),
      hasRefPhoto: !!rec.refPhoto,
      createdAt: rec.createdAt || rec.ts || 0,
      ts: rec.ts || rec.createdAt || 0,
    });
  }
  return json({ ok: true, date: hkDate(), requests: out.slice(0, 100) });
}

/* 店主睇單一申請成個記錄（包括手相＋效果圖）。 */
async function handleAdminRequestDetail(request, env, id) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const found = await findRequest(env, id);
  if (!found) {
    return json({ ok: false, error: "搵唔到呢個申請" }, 404);
  }
  return json({ ok: true, request: found.rec });
}

/* 店主將申請標做完成：效果圖本身存入 KV（resultImage data URL），
   或者用 resultUrl 連結做後備。 */
async function handleAdminRequestComplete(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await readJson(request);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    return json({ ok: false, error: "請提供申請編號" }, 400);
  }
  const found = await findRequest(env, id);
  if (!found) {
    return json({ ok: false, error: "搵唔到呢個申請" }, 404);
  }
  const resultImage = body?.resultImage;
  const resultUrl = typeof body?.resultUrl === "string" ? body.resultUrl.trim() : "";
  if (resultImage !== undefined && resultImage !== null && resultImage !== "") {
    if (imageTooBig(resultImage)) {
      return json({ ok: false, error: "效果圖太大，請用細啲嘅圖" }, 400);
    }
    if (!isDataUrlImage(resultImage)) {
      return json({ ok: false, error: "效果圖格式唔啱，請用 JPG 或者 PNG" }, 400);
    }
  } else if (resultUrl) {
    if (!isHttpsUrl(resultUrl)) {
      return json({ ok: false, error: "效果圖連結唔啱" }, 400);
    }
  } else {
    return json({ ok: false, error: "請提供效果圖（圖片或者連結）" }, 400);
  }
  const rec = found.rec;
  rec.status = "done";
  rec.completedAt = Date.now();
  if (resultImage) {
    rec.resultImage = resultImage;
    rec.resultUrl = null;
  } else {
    rec.resultUrl = resultUrl;
    rec.resultImage = null;
  }
  await env.TRYON_KV.put(found.key, JSON.stringify(rec));
  return json({
    ok: true,
    request: {
      id: rec.id || "",
      design: rec.design || "",
      designLink: rec.designLink || "",
      status: rec.status,
      resultUrl: rec.resultUrl || null,
      resultImage: rec.resultImage || null,
      createdAt: rec.createdAt || rec.ts || 0,
      ts: rec.ts || rec.createdAt || 0,
    },
  });
}

/* 刪除超過 7 日嘅申請記錄（連手相、效果圖同嗰條 key 一齊清走）。 */
async function handleAdminRequestsCleanup(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const cutoff = Date.now() - RETENTION_MS;
  const keys = await listAllKeys(env, "req:");
  let deleted = 0;
  for (const item of keys) {
    const rec = await loadRequest(env, item.name);
    const at = rec ? rec.createdAt || rec.ts || 0 : 0;
    if (!rec || at < cutoff) {
      await env.TRYON_KV.delete(item.name);
      deleted++;
    }
  }
  return json({ ok: true, deleted });
}

/* 店主切換去用家模式：開一個 TEST 測試身分嘅客人 session，
   等用家模式可以照常用客人 token 提交申請、睇自己嘅效果圖。 */
async function handleAdminTestSession(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const token = await createSession(env, {
    qr: "test",
    unlimited: true,
    created: Date.now(),
  });
  return json({ ok: true, token });
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

/* 店主撳「同步客戶資料」：記低請求，等 Muse 定期檢查到就去 Pass2U 匯出再匯入。 */
async function handleAdminSyncRequest(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  if (request.method === "GET") {
    const raw = await env.TRYON_KV.get("sync-request");
    const lastRaw = await env.TRYON_KV.get("sync-status");
    return json({
      ok: true,
      request: raw ? JSON.parse(raw) : null,
      lastSync: lastRaw ? JSON.parse(lastRaw) : null,
    });
  }
  const req = { status: "pending", requestedAt: Date.now() };
  await env.TRYON_KV.put("sync-request", JSON.stringify(req));
  return json({ ok: true, request: req });
}

/* Muse 做完同步之後記低結果，同時清走請求。 */
async function handleAdminSyncComplete(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: "請先以店主身份登入" }, 401);
  }
  const body = await request.json().catch(() => ({}));
  const status = {
    at: Date.now(),
    created: typeof body?.created === "number" ? body.created : 0,
    updated: typeof body?.updated === "number" ? body.updated : 0,
    total: typeof body?.total === "number" ? body.total : 0,
  };
  await env.TRYON_KV.put("sync-status", JSON.stringify(status));
  await env.TRYON_KV.delete("sync-request");
  return json({ ok: true, lastSync: status });
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
    if (path === "/api/my-requests" && request.method === "GET") {
      return handleMyRequests(request, env);
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
    if (path === "/api/admin/requests/complete" && request.method === "POST") {
      return handleAdminRequestComplete(request, env);
    }
    if (path === "/api/admin/requests/cleanup" && request.method === "POST") {
      return handleAdminRequestsCleanup(request, env);
    }
    if (path === "/api/admin/test-session" && request.method === "POST") {
      return handleAdminTestSession(request, env);
    }
    if (path.startsWith("/api/admin/requests/") && request.method === "GET") {
      const id = path.slice("/api/admin/requests/".length);
      if (!id || id.includes("/")) {
        return json({ ok: false, error: "not found" }, 404);
      }
      return handleAdminRequestDetail(request, env, id);
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
    if (path === "/api/admin/sync-request" && (request.method === "GET" || request.method === "POST")) {
      return handleAdminSyncRequest(request, env);
    }
    if (path === "/api/admin/sync-complete" && request.method === "POST") {
      return handleAdminSyncComplete(request, env);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
