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
