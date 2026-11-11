// 本地測試：用記憶體 KV 假裝 Cloudflare KV，跑 Worker 全部端點。
// 呢度用嘅密碼純粹係測試假值，唔係真密碼。
// 用法：node test-local.mjs

import worker from "./src/index.js";
import { createHash } from "node:crypto";

// ---- 記憶體 KV mock（Cloudflare KV 介面子集）----
function createMockKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: null };
    },
  };
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const env = {
  TRYON_KV: createMockKv(),
  GUEST_PASSWORD_HASH: sha256("test-guest-password"),
  ADMIN_PASSWORD_HASH: sha256("test-admin-password"),
};

const BASE = "https://tryon.test";

async function call(path, { method = "POST", body = null, token = null, ip = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers["X-Forwarded-For"] = ip;
  const res = await worker.fetch(
    new Request(BASE + path, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    }),
    env,
    {},
  );
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 無 JSON 內容（例如 OPTIONS 204）
  }
  return { status: res.status, data };
}

// 測試用嘅細相（1x1 JPEG 手相／1x1 PNG 效果圖）＋一張超過 5MB 嘅大相
const SMALL_PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==";
const SMALL_RESULT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BIG_PHOTO = "data:image/jpeg;base64," + "A".repeat(7000000);

function hkDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

console.log("== health ==");
{
  const r = await call("/api/health", { method: "GET" });
  check("health 回 ok:true", r.status === 200 && r.data?.ok === true);
}

console.log("== 客人登入 ==");
let guestToken;
{
  const r = await call("/api/login", {
    body: { qr: "  AbC123 ", password: "test-guest-password" },
  });
  check("正確密碼登入成功", r.status === 200 && r.data?.ok === true);
  check("登入回 remaining 3", r.data?.remaining === 3);
  check("回 token（64 字 hex）", /^[0-9a-f]{64}$/.test(r.data?.token ?? ""));
  guestToken = r.data?.token;
}
{
  const r = await call("/api/login", {
    body: { qr: "abc123", password: "wrong-password" },
  });
  check("錯密碼拒絕（401）", r.status === 401 && r.data?.ok === false);
}
{
  const r = await call("/api/quota", { body: { token: "唔存在嘅 token" } });
  check("假 token 查 quota 拒絕（401）", r.status === 401);
}

console.log("== 每日限額 3 次 ==");
{
  const q0 = await call("/api/quota", { body: { token: guestToken } });
  check("未用之前 remaining 3", q0.data?.remaining === 3);
  for (let i = 1; i <= 3; i++) {
    const s = await call("/api/submit", {
      body: { token: guestToken, design: "布甸狗 3D", handPhoto: SMALL_PHOTO },
    });
    check(`第 ${i} 次提交成功，remaining ${3 - i}`, s.status === 200 && s.data?.remaining === 3 - i);
  }
  const s4 = await call("/api/submit", {
    body: { token: guestToken, design: "布甸狗 3D", handPhoto: SMALL_PHOTO },
  });
  check("第 4 次提交被拒（今日額滿）", s4.status === 403 && s4.data?.error === "今日額滿");
}

console.log("== 隔日重設（昨日用量唔計入今日）==");
{
  // 直接喺 KV 寫一條「昨日」用量，睇下今日會唔會受影響。
  await env.TRYON_KV.put(`quota:${hkDate(-1)}:newuser`, "3");
  const r = await call("/api/login", {
    body: { qr: "newuser", password: "test-guest-password" },
  });
  check("昨日用滿 3 次，今日仍然 remaining 3", r.data?.remaining === 3);
}

console.log("== TEST 帳戶無限次 ==");
{
  const r = await call("/api/login", {
    body: { qr: " test ", password: "test-guest-password" },
  });
  check("TEST 登入 unlimited:true", r.data?.unlimited === true && r.data?.remaining === null);
  let allOk = true;
  for (let i = 0; i < 5; i++) {
    const s = await call("/api/submit", { body: { token: r.data.token, design: "測試款", handPhoto: SMALL_PHOTO } });
    if (!(s.status === 200 && s.data?.unlimited === true)) allOk = false;
  }
  check("TEST 提交 5 次全部成功", allOk);
}

console.log("== 店主 ==");
let adminToken;
{
  const bad = await call("/api/admin/login", { body: { password: "wrong" } });
  check("店主錯密碼拒絕（401）", bad.status === 401);
  const good = await call("/api/admin/login", { body: { password: "test-admin-password" } });
  check("店主正確密碼登入成功", good.status === 200 && good.data?.ok === true);
  adminToken = good.data?.token;
}
{
  const noAuth = await call("/api/admin/usage", { method: "GET" });
  check("無 token 查用量拒絕（401）", noAuth.status === 401);
  const u = await call("/api/admin/usage", { method: "GET", token: adminToken });
  const row = u.data?.usage?.find((x) => x.qr === "abc123");
  check("用量表見到 abc123 用咗 3 次", u.status === 200 && row?.used === 3 && row?.remaining === 0);
}
{
  const reqs = await call("/api/admin/requests", { method: "GET", token: adminToken });
  check("申請記錄有今日嘅提交", reqs.status === 200 && reqs.data?.requests?.length >= 8);
  check("申請記錄最新先行", reqs.data.requests[0].ts >= reqs.data.requests.at(-1).ts);
}
{
  const reset = await call("/api/admin/reset", {
    body: { qr: "ABC123" },
    token: adminToken,
  });
  check("重設 abc123 回 remaining 3", reset.status === 200 && reset.data?.remaining === 3);
  const s = await call("/api/submit", {
    body: { token: guestToken, design: "重設後再試", handPhoto: SMALL_PHOTO },
  });
  check("重設後客人可以再提交", s.status === 200 && s.data?.remaining === 2);
}

console.log("== 帳戶管理 ==");
{
  // 未登記嘅 QR 照樣登入到（沿用共用密碼制）
  const r = await call("/api/login", {
    body: { qr: "cust001", password: "test-guest-password" },
  });
  check("未登記帳戶照樣登入到", r.status === 200 && r.data?.ok === true);
  const custToken = r.data?.token;
  // 掃 QR 開帳戶
  const c = await call("/api/admin/accounts/create", {
    body: { qr: "CUST001", name: "阿 May" },
    token: adminToken,
  });
  check("開帳戶成功，QR 歸一化做小楷", c.status === 200 && c.data?.account?.qr === "cust001" && c.data?.account?.name === "阿 May");
  const c2 = await call("/api/admin/accounts/create", {
    body: { qr: "cust001" },
    token: adminToken,
  });
  check("重複開同一個帳戶回 existed:true", c2.status === 200 && c2.data?.existed === true);
  // 帳戶名單見到名
  const list = await call("/api/admin/accounts", { method: "GET", token: adminToken });
  const row = list.data?.accounts?.find((x) => x.qr === "cust001");
  check("帳戶名單見到阿 May", list.status === 200 && row?.name === "阿 May" && row?.status === "active");
  // 停用就登入唔到
  const dis = await call("/api/admin/accounts/update", {
    body: { qr: "cust001", status: "disabled" },
    token: adminToken,
  });
  check("停用帳戶成功", dis.status === 200 && dis.data?.account?.status === "disabled");
  const blocked = await call("/api/login", {
    body: { qr: "cust001", password: "test-guest-password" },
  });
  check("已停用帳戶登入被拒（403）", blocked.status === 403);
  // 改名＋重新啟用
  const upd = await call("/api/admin/accounts/update", {
    body: { qr: "cust001", name: "阿 May（改名）", status: "active" },
    token: adminToken,
  });
  check("改名＋啟用成功", upd.status === 200 && upd.data?.account?.name === "阿 May（改名）");
  const back = await call("/api/login", {
    body: { qr: "cust001", password: "test-guest-password" },
  });
  check("啟用後登入返得", back.status === 200 && back.data?.ok === true);
  // 作廢就登入唔到
  await call("/api/admin/accounts/update", {
    body: { qr: "cust001", status: "void" },
    token: adminToken,
  });
  const voided = await call("/api/login", {
    body: { qr: "cust001", password: "test-guest-password" },
  });
  check("已作廢帳戶登入被拒（403）", voided.status === 403);
  // 刪除帳戶後，未登記狀態，照樣登入到
  const del = await call("/api/admin/accounts/delete", {
    body: { qr: "cust001" },
    token: adminToken,
  });
  check("刪除帳戶成功", del.status === 200);
  const gone = await call("/api/login", {
    body: { qr: "cust001", password: "test-guest-password" },
  });
  check("刪除後登入返得（未登記照入）", gone.status === 200 && gone.data?.ok === true);
  // CSV 匯入：新增＋更新名
  const imp = await call("/api/admin/accounts/import", {
    body: { rows: [
      { qr: "cust002", name: "阿強" },
      { qr: "cust003", name: "阿珍" },
      { qr: "cust002", name: "阿強（更新）" },
      { qr: "", name: "無 QR" },
    ] },
    token: adminToken,
  });
  check("CSV 匯入：新增 2、更新 1、跳過 1", imp.status === 200 && imp.data?.created === 2 && imp.data?.updated === 1 && imp.data?.skipped === 1);
  const list2 = await call("/api/admin/accounts", { method: "GET", token: adminToken });
  const r2 = list2.data?.accounts?.find((x) => x.qr === "cust002");
  check("匯入後 cust002 個名更新咗", r2?.name === "阿強（更新）");
  // 套票卡連結：開帳戶嗰陣一齊存，登入嗰陣回返俾頁面顯示
  const pc = await call("/api/admin/accounts/create", {
    body: { qr: "pass001", name: "阿卡", passUrl: "https://www.pass2u.net/d/example-pass-link" },
    token: adminToken,
  });
  check("開帳戶連卡連結一齊存到", pc.status === 200 && pc.data?.account?.passUrl === "https://www.pass2u.net/d/example-pass-link");
  const pl = await call("/api/login", {
    body: { qr: "pass001", password: "test-guest-password" },
  });
  check("登入回覆有客人名＋卡連結", pl.status === 200 && pl.data?.name === "阿卡" && pl.data?.passUrl === "https://www.pass2u.net/d/example-pass-link");
  const pu = await call("/api/admin/accounts/update", {
    body: { qr: "pass001", passUrl: "https://www.pass2u.net/d/updated-link" },
    token: adminToken,
  });
  check("更新卡連結成功", pu.status === 200 && pu.data?.account?.passUrl === "https://www.pass2u.net/d/updated-link");
  const pi = await call("/api/admin/accounts/import", {
    body: { rows: [{ qr: "pass002", name: "阿 link", passUrl: "https://www.pass2u.net/d/csv-link" }] },
    token: adminToken,
  });
  check("CSV 匯入連卡連結一齊新增", pi.status === 200 && pi.data?.created === 1);
  const pl2 = await call("/api/admin/accounts", { method: "GET", token: adminToken });
  const pr2 = pl2.data?.accounts?.find((x) => x.qr === "pass002");
  check("帳戶名單見到 CSV 匯入嘅卡連結", pr2?.passUrl === "https://www.pass2u.net/d/csv-link");
  // Pass2U 匯出同步：passId 自動計下載連結，已用次數計剩餘
  const ps = await call("/api/admin/accounts/import", {
    body: { rows: [
      { qr: "45391582", name: "Yan", passId: "WR4eaAvuSLsW", used: 0 },
      { qr: "39515934", name: "Canise Lui", passId: "Wncsz07-rJuq", used: 2 },
    ] },
    token: adminToken,
  });
  check("Pass2U 格式匯入新增 2 個帳戶", ps.status === 200 && ps.data?.created === 2);
  const pl3 = await call("/api/login", {
    body: { qr: "39515934", password: "test-guest-password" },
  });
  check("登入回覆有套票剩餘次數（6−2=4）", pl3.status === 200 && pl3.data?.sessionsUsed === 2 && pl3.data?.sessionsLeft === 4);
  check("登入回覆有 Pass2U 下載連結", pl3.data?.passUrl === "https://www.pass2u.net/d/Wncsz07-rJuq?t=qr_code&openExternalBrowser=1");
  const ps2 = await call("/api/admin/accounts/import", {
    body: { rows: [{ qr: "39515934", name: "Canise Lui", passId: "Wncsz07-rJuq", used: 3 }] },
    token: adminToken,
  });
  check("再匯入同一張卡會更新已用次數", ps2.status === 200 && ps2.data?.updated === 1);
  const pl4 = await call("/api/login", {
    body: { qr: "39515934", password: "test-guest-password" },
  });
  check("更新後剩餘次數變返 3", pl4.data?.sessionsLeft === 3);
  // 同步客戶資料請求：店主撳掣記低請求，Muse 做完記低結果清走請求
  const sr0 = await call("/api/admin/sync-request", { method: "GET", token: adminToken });
  check("未撳過同步：無請求、無上次記錄", sr0.status === 200 && sr0.data?.request === null && sr0.data?.lastSync === null);
  const sr1 = await call("/api/admin/sync-request", { method: "POST", token: adminToken });
  check("撳同步掣記低 pending 請求", sr1.status === 200 && sr1.data?.request?.status === "pending");
  const sr2 = await call("/api/admin/sync-request", { method: "GET", token: adminToken });
  check("再查見到 pending 請求", sr2.data?.request?.status === "pending");
  const sc = await call("/api/admin/sync-complete", {
    body: { created: 2, updated: 10, total: 12 },
    token: adminToken,
  });
  check("同步完成記低結果", sc.status === 200 && sc.data?.lastSync?.total === 12 && sc.data?.lastSync?.created === 2);
  const sr3 = await call("/api/admin/sync-request", { method: "GET", token: adminToken });
  check("同步完成後請求清走、上次記錄留低", sr3.data?.request === null && sr3.data?.lastSync?.total === 12);
  const sr4 = await call("/api/admin/sync-request", { method: "POST" });
  check("無 token 撳同步拒絕（401）", sr4.status === 401);
  // 無 token 唔俾開帳戶
  const noAuth = await call("/api/admin/accounts/create", {
    body: { qr: "cust999", name: "唔應該入到" },
  });
  check("無 token 開帳戶拒絕（401）", noAuth.status === 401);
  // 用量表有埋客人名
  const u = await call("/api/admin/usage", { method: "GET", token: adminToken });
  check("用量表有客人名欄位", u.status === 200 && Array.isArray(u.data?.usage));
}

console.log("== 頁面提交＋我嘅效果圖＋7 日保留 ==");
let reqToken, reqId;
{
  const login = await call("/api/login", {
    body: { qr: "requser", password: "test-guest-password" },
  });
  check("申請測試帳戶登入成功", login.status === 200 && login.data?.ok === true);
  reqToken = login.data?.token;
  // 冇手相唔俾提交
  const noPhoto = await call("/api/submit", {
    body: { token: reqToken, design: "布甸狗 3D" },
  });
  check("冇手相提交被拒（400）", noPhoto.status === 400);
  // 相太大唔俾提交
  const big = await call("/api/submit", {
    body: { token: reqToken, design: "布甸狗 3D", handPhoto: BIG_PHOTO },
  });
  check("相太大提交被拒（400 相太大）", big.status === 400 && (big.data?.error || "").includes("相太大"));
  // 正常提交：連手相、款名、IG 連結
  const s1 = await call("/api/submit", {
    body: { token: reqToken, design: "布甸狗 3D", designLink: "https://www.instagram.com/p/Dd8xuoSvhGT/", handPhoto: SMALL_PHOTO },
  });
  check("連手相提交成功，有 id、remaining 2", s1.status === 200 && typeof s1.data?.id === "string" && s1.data?.id.length > 0 && s1.data?.remaining === 2);
  reqId = s1.data?.id;
  const s2 = await call("/api/submit", {
    body: { token: reqToken, design: "貓眼款", handPhoto: SMALL_PHOTO },
  });
  check("第 2 次提交成功，remaining 1", s2.status === 200 && s2.data?.remaining === 1);
  const s3 = await call("/api/submit", {
    body: { token: reqToken, design: "鏡面款", handPhoto: SMALL_PHOTO },
  });
  check("第 3 次提交成功，remaining 0", s3.status === 200 && s3.data?.remaining === 0);
  const s4 = await call("/api/submit", {
    body: { token: reqToken, design: "再試", handPhoto: SMALL_PHOTO },
  });
  check("第 4 次提交被拒（今日額滿）", s4.status === 403 && s4.data?.error === "今日額滿");
}
{
  // my-requests：只回自己嘅申請，最新先，唔回手相
  const mine = await call("/api/my-requests", { method: "GET", token: reqToken });
  check("my-requests 回到自己 3 個申請", mine.status === 200 && mine.data?.requests?.length === 3);
  check("my-requests 最新先行", mine.data.requests[0].createdAt >= mine.data.requests.at(-1).createdAt);
  check("my-requests 有 id、款名、狀態 pending", mine.data.requests.every((r) => r.id && r.design && r.status === "pending"));
  check("my-requests 唔回手相", mine.data.requests.every((r) => !("handPhoto" in r)));
  check("my-requests 有申請 id 同提交嗰個對得上", mine.data.requests.some((r) => r.id === reqId));
  // 另一個客嘅申請唔會出現
  const other = await call("/api/login", {
    body: { qr: "otheruser", password: "test-guest-password" },
  });
  const otherToken = other.data?.token;
  await call("/api/submit", {
    body: { token: otherToken, design: "其他客嘅款", handPhoto: SMALL_PHOTO },
  });
  const mine2 = await call("/api/my-requests", { method: "GET", token: reqToken });
  check("my-requests 唔會見到其他客嘅申請", mine2.data?.requests?.length === 3 && mine2.data.requests.every((r) => r.design !== "其他客嘅款"));
  const otherMine = await call("/api/my-requests", { method: "GET", token: otherToken });
  check("其他客 my-requests 只見到自己 1 個", otherMine.data?.requests?.length === 1 && otherMine.data.requests[0].design === "其他客嘅款");
  // 未登入／錯 token 回 401
  const noAuth = await call("/api/my-requests", { method: "GET" });
  check("無 token 查 my-requests 拒絕（401）", noAuth.status === 401);
  const badAuth = await call("/api/my-requests", { method: "GET", token: "bad-token-xyz" });
  check("假 token 查 my-requests 拒絕（401）", badAuth.status === 401);
}
{
  // admin list：7 日內、有齊名／款／時間／狀態，唔回手相同效果圖本身
  const list = await call("/api/admin/requests", { method: "GET", token: adminToken });
  const row = list.data?.requests?.find((r) => r.id === reqId);
  check("admin list 見到新申請", list.status === 200 && !!row);
  check("admin list 有狀態 pending＋未有效果圖", row?.status === "pending" && row?.hasResult === false);
  check("admin list 唔回手相同效果圖本身", row && !("handPhoto" in row) && !("resultImage" in row));
  // admin detail：回到手相
  const detail = await call(`/api/admin/requests/${reqId}`, { method: "GET", token: adminToken });
  check("admin detail 回到手相", detail.status === 200 && detail.data?.request?.handPhoto === SMALL_PHOTO);
  check("admin detail 有款名同 IG 連結", detail.data?.request?.design === "布甸狗 3D" && detail.data?.request?.designLink === "https://www.instagram.com/p/Dd8xuoSvhGT/");
  const detailNoAuth = await call(`/api/admin/requests/${reqId}`, { method: "GET" });
  check("無 token 睇 detail 拒絕（401）", detailNoAuth.status === 401);
  const detail404 = await call("/api/admin/requests/唔存在嘅id", { method: "GET", token: adminToken });
  check("唔存在嘅申請 detail 回 404", detail404.status === 404);
  // complete：用 resultImage
  const done = await call("/api/admin/requests/complete", {
    body: { id: reqId, resultImage: SMALL_RESULT },
    token: adminToken,
  });
  check("complete 用 resultImage 成功變 done", done.status === 200 && done.data?.request?.status === "done");
  const mine3 = await call("/api/my-requests", { method: "GET", token: reqToken });
  const doneRow = mine3.data?.requests?.find((r) => r.id === reqId);
  check("my-requests 見到已完成＋效果圖", doneRow?.status === "done" && doneRow?.resultImage === SMALL_RESULT);
  // complete：用 resultUrl 做後備
  const catId = mine3.data.requests.find((r) => r.design === "貓眼款")?.id;
  const done2 = await call("/api/admin/requests/complete", {
    body: { id: catId, resultUrl: "https://example.com/result.jpg" },
    token: adminToken,
  });
  check("complete 用 resultUrl 做後備成功", done2.status === 200 && done2.data?.request?.resultUrl === "https://example.com/result.jpg");
  const done404 = await call("/api/admin/requests/complete", {
    body: { id: "唔存在嘅id", resultUrl: "https://example.com/x.jpg" },
    token: adminToken,
  });
  check("唔存在嘅申請 complete 回 404", done404.status === 404);
  const doneBad = await call("/api/admin/requests/complete", {
    body: { id: reqId, resultImage: "data:text/plain;base64,xxxx" },
    token: adminToken,
  });
  check("格式唔啱嘅效果圖 complete 被拒（400）", doneBad.status === 400);
  const doneNoAuth = await call("/api/admin/requests/complete", {
    body: { id: reqId, resultUrl: "https://example.com/x.jpg" },
  });
  check("無 token complete 拒絕（401）", doneNoAuth.status === 401);
}
{
  // 自備參考相跟埋申請一齊傳去（用獨立帳戶，唔會食咗 requser 嘅限額）
  const login = await call("/api/login", {
    body: { qr: "refuser", password: "test-guest-password" },
  });
  check("參考相測試帳戶登入成功", login.status === 200 && login.data?.ok === true);
  const refToken = login.data?.token;
  // 連 refPhoto 提交成功
  const s = await call("/api/submit", {
    body: { token: refToken, design: "自備參考相款", handPhoto: SMALL_PHOTO, refPhoto: SMALL_RESULT },
  });
  check("連 refPhoto 提交成功，有 id", s.status === 200 && typeof s.data?.id === "string" && s.data.id.length > 0);
  const refId = s.data?.id;
  // my-requests 有 hasRefPhoto true，唔回 refPhoto 本身
  const mine = await call("/api/my-requests", { method: "GET", token: refToken });
  const row = mine.data?.requests?.find((r) => r.id === refId);
  check("my-requests 有 hasRefPhoto true", row?.hasRefPhoto === true);
  check("my-requests 唔回 refPhoto 本身", mine.data.requests.every((r) => !("refPhoto" in r)));
  // admin list 有 hasRefPhoto
  const list = await call("/api/admin/requests", { method: "GET", token: adminToken });
  const lrow = list.data?.requests?.find((r) => r.id === refId);
  check("admin list 有 hasRefPhoto true", lrow?.hasRefPhoto === true);
  check("admin list 唔回 refPhoto 本身", lrow && !("refPhoto" in lrow));
  // admin detail 回到 refPhoto
  const detail = await call(`/api/admin/requests/${refId}`, { method: "GET", token: adminToken });
  check("admin detail 回到 refPhoto", detail.status === 200 && detail.data?.request?.refPhoto === SMALL_RESULT);
  // refPhoto 太大回 400（唔會計入限額）
  const big = await call("/api/submit", {
    body: { token: refToken, design: "大參考相", handPhoto: SMALL_PHOTO, refPhoto: BIG_PHOTO },
  });
  check("refPhoto 太大提交被拒（400 相太大）", big.status === 400 && (big.data?.error || "").includes("相太大"));
  // refPhoto 格式唔啱回 400
  const bad = await call("/api/submit", {
    body: { token: refToken, design: "錯格式參考相", handPhoto: SMALL_PHOTO, refPhoto: "data:text/plain;base64,xxxx" },
  });
  check("refPhoto 格式唔啱提交被拒（400）", bad.status === 400);
  // 冇 refPhoto 嘅申請照常運作
  const s2 = await call("/api/submit", {
    body: { token: refToken, design: "冇參考相款", handPhoto: SMALL_PHOTO },
  });
  check("冇 refPhoto 提交成功", s2.status === 200 && typeof s2.data?.id === "string");
  const mine2 = await call("/api/my-requests", { method: "GET", token: refToken });
  const row2 = mine2.data?.requests?.find((r) => r.id === s2.data?.id);
  check("冇 refPhoto 嘅申請 hasRefPhoto false", row2?.hasRefPhoto === false);
  const detail2 = await call(`/api/admin/requests/${s2.data?.id}`, { method: "GET", token: adminToken });
  check("冇 refPhoto 嘅申請 detail 冇 refPhoto", detail2.status === 200 && (detail2.data?.request?.refPhoto === null || detail2.data?.request?.refPhoto === undefined));
  const list2 = await call("/api/admin/requests", { method: "GET", token: adminToken });
  const lrow2 = list2.data?.requests?.find((r) => r.id === s2.data?.id);
  check("冇 refPhoto 嘅申請 admin list hasRefPhoto false", lrow2?.hasRefPhoto === false);
}
{
  // 7 日保留：直接喺 KV 寫入舊記錄
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const oldKey = `req:${hkDate(-8)}:${now - 8 * day}-seedold`;
  await env.TRYON_KV.put(oldKey, JSON.stringify({ id: "seed-old-8d", qr: "requser", name: "", design: "8 日前嘅款", designLink: "", handPhoto: SMALL_PHOTO, status: "pending", resultUrl: null, resultImage: null, createdAt: now - 8 * day, ts: now - 8 * day }));
  const expKey = `req:${hkDate(-7)}:${now - 7 * day - 3600000}-seedexp`;
  await env.TRYON_KV.put(expKey, JSON.stringify({ id: "seed-exp-7d", qr: "requser", name: "", design: "7 日多 1 個鐘前嘅款", designLink: "", handPhoto: SMALL_PHOTO, status: "pending", resultUrl: null, resultImage: null, createdAt: now - 7 * day - 3600000, ts: now - 7 * day - 3600000 }));
  const keepKey = `req:${hkDate(-6)}:${now - 6 * day}-seedkeep`;
  await env.TRYON_KV.put(keepKey, JSON.stringify({ id: "seed-keep-6d", qr: "requser", name: "", design: "6 日前嘅款", designLink: "", handPhoto: SMALL_PHOTO, status: "pending", resultUrl: null, resultImage: null, createdAt: now - 6 * day, ts: now - 6 * day }));
  const mine4 = await call("/api/my-requests", { method: "GET", token: reqToken });
  check("my-requests 唔會出現超過 7 日嘅申請", mine4.data?.requests?.every((r) => r.id !== "seed-old-8d" && r.id !== "seed-exp-7d"));
  check("my-requests 會出現 6 日前嘅申請", mine4.data?.requests?.some((r) => r.id === "seed-keep-6d"));
  const list2 = await call("/api/admin/requests", { method: "GET", token: adminToken });
  check("admin list 唔會出現超過 7 日嘅申請", list2.data?.requests?.every((r) => r.id !== "seed-old-8d" && r.id !== "seed-exp-7d"));
  check("admin list 會出現 6 日前嘅申請", list2.data?.requests?.some((r) => r.id === "seed-keep-6d"));
  // cleanup
  const cl = await call("/api/admin/requests/cleanup", { method: "POST", token: adminToken });
  check("cleanup 刪除 2 個過期記錄", cl.status === 200 && cl.data?.deleted === 2);
  check("cleanup 之後過期 key 已經唔喺 KV", (await env.TRYON_KV.get(oldKey)) === null && (await env.TRYON_KV.get(expKey)) === null);
  check("cleanup 唔會刪除未過期嘅記錄", (await env.TRYON_KV.get(keepKey)) !== null);
  const cl2 = await call("/api/admin/requests/cleanup", { method: "POST", token: adminToken });
  check("再 cleanup 已經冇嘢刪（deleted 0）", cl2.status === 200 && cl2.data?.deleted === 0);
  const clNoAuth = await call("/api/admin/requests/cleanup", { method: "POST" });
  check("無 token cleanup 拒絕（401）", clNoAuth.status === 401);
}

console.log("== 登入限速 ==");
{
  // 用一個獨立 IP，錯 10 次之後第 11 次要回 429。
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call("/api/login", {
      body: { qr: "abc123", password: "wrong-password" },
      ip: "9.9.9.9",
    });
  }
  check("同一 IP 錯 11 次後回 429", last.status === 429);
}

console.log("== Workers AI 測試（ai-test 端點）==");
{
  // 本地 mock 預設冇 env.AI：回 503
  const noAi = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("未設定 AI 回 503", noAi.status === 503 && (noAi.data?.error || "").includes("AI 未設定"));
  // 無 token → 401（就算未設定 AI 都係先驗證身份）
  const noAuth = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink" },
  });
  check("無 token ai-test 拒絕（401）", noAuth.status === 401);
  // 掛一個 mock AI：模擬 binding 回 ReadableStream（官方文件寫明）
  const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  env.AI = {
    calls: [],
    async run(model, inputs) {
      this.calls.push({ model, inputs });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(FAKE_PNG);
          controller.close();
        },
      });
    },
  };
  // 圖片格式錯 → 400
  const badImg = await call("/api/admin/ai-test", {
    body: { image: "data:text/plain;base64,xxxx", prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("圖片格式唔啱回 400", badImg.status === 400);
  // 相太大 → 400
  const bigImg = await call("/api/admin/ai-test", {
    body: { image: BIG_PHOTO, prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("相太大回 400", bigImg.status === 400 && (bigImg.data?.error || "").includes("相太大"));
  // prompt 空 → 400
  const noPrompt = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "   " },
    token: adminToken,
  });
  check("prompt 空回 400", noPrompt.status === 400);
  // strength 超出 0–1 → 400
  const badStrength = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink", strength: 1.5 },
    token: adminToken,
  });
  check("strength 超出 0–1 回 400", badStrength.status === 400);
  // 成功：回 data URL＋model 名，傳入去 AI 嘅參數要啱
  const ok = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink with Hello Kitty design", strength: 0.6 },
    token: adminToken,
  });
  check("mock AI 生成成功回 200＋PNG data URL", ok.status === 200 && ok.data?.ok === true && typeof ok.data?.image === "string" && ok.data.image.startsWith("data:image/png;base64,"));
  check("回覆有 model 名", ok.data?.model === "@cf/stabilityai/stable-diffusion-xl-base-1.0");
  const lastCall = env.AI.calls.at(-1);
  check("傳去 AI 嘅 model 啱", lastCall?.model === "@cf/stabilityai/stable-diffusion-xl-base-1.0");
  check("傳去 AI 嘅係 image_b64（純 base64，唔帶 data: 前綴）", lastCall?.inputs?.image_b64 === SMALL_PHOTO.split(",", 2)[1]);
  check("傳去 AI 嘅 strength 係 0.6", lastCall?.inputs?.strength === 0.6);
  check("傳去 AI 嘅 prompt 啱", lastCall?.inputs?.prompt === "paint the nails pink with Hello Kitty design");
  // 唔傳 strength 就用預設 0.6
  await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("唔傳 strength 就用預設 0.6", env.AI.calls.at(-1)?.inputs?.strength === 0.6);
  // mock AI 拋錯 → 502，唔會假裝成功
  env.AI.run = async () => { throw new Error("mock AI 失敗"); };
  const err = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("AI 出錯回 502", err.status === 502 && err.data?.ok === false);
  // mock AI 回空結果 → 502
  env.AI.run = async () => null;
  const empty = await call("/api/admin/ai-test", {
    body: { image: SMALL_PHOTO, prompt: "paint the nails pink" },
    token: adminToken,
  });
  check("AI 回空結果回 502", empty.status === 502 && empty.data?.ok === false);
}

console.log(`\n結果：${passed} 通過，${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
