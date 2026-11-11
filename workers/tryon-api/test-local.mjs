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
      body: { token: guestToken, design: "布甸狗 3D" },
    });
    check(`第 ${i} 次提交成功，remaining ${3 - i}`, s.status === 200 && s.data?.remaining === 3 - i);
  }
  const s4 = await call("/api/submit", {
    body: { token: guestToken, design: "布甸狗 3D" },
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
    const s = await call("/api/submit", { body: { token: r.data.token, design: "測試款" } });
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
    body: { token: guestToken, design: "重設後再試" },
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
  // 無 token 唔俾開帳戶
  const noAuth = await call("/api/admin/accounts/create", {
    body: { qr: "cust999", name: "唔應該入到" },
  });
  check("無 token 開帳戶拒絕（401）", noAuth.status === 401);
  // 用量表有埋客人名
  const u = await call("/api/admin/usage", { method: "GET", token: adminToken });
  check("用量表有客人名欄位", u.status === 200 && Array.isArray(u.data?.usage));
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

console.log(`\n結果：${passed} 通過，${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
