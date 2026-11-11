# 試甲 API — Cloudflare Worker 部署說明

呢個 Worker 係試甲公開頁嘅伺服器：核對登入密碼、計每日 3 次限額、等店主查用量同重設。佢唔生成圖片、唔存相片。免費層夠用。

> ⚠️ 重要：舊嘅共用臨時密碼曾經喺一個草稿版入面明文出現過，**唔好再用**。下面第 2 步要揀一個**全新**嘅客人密碼，同一個全新嘅店主密碼。兩個密碼唔好相同。

## 1. 開一個 KV namespace

1. 去 Cloudflare Dashboard（https://dash.cloudflare.com/）登入。
2. 左邊撳 **Workers & Pages** → **KV**（或「KV」→「建立」）。
3. 名稱打 `sugarnail-tryon`，撳建立。
4. 建立完會見到一個 **ID**（一串英數字），抄低佢。
5. 打開 `workers/tryon-api/wrangler.toml`，將 `REPLACE_WITH_KV_NAMESPACE_ID` 換做嗰個 ID。

## 2. 設定兩個密碼核對值（Worker secrets）

密碼本身唔會放喺任何檔案入面，只放佢嘅 SHA-256 值。先喺自己電腦計：

```bash
echo -n '你揀嘅新客人密碼' | sha256sum
echo -n '你揀嘅新店主密碼' | sha256sum
```

每個指令會出一串 64 個字嘅 hex，抄低。然後去 Dashboard：

1. **Workers & Pages** → 撳 `sugarnail-tryon-api` 呢個 Worker（第一次部署之後先會出現；如果未部署過，先做第 3 步，部署完返嚟呢度）。
2. **設定** → **變數** → **新增變數**（或「Secrets」→「新增」）：
   - 名稱 `GUEST_PASSWORD_HASH`，值係客人密碼嗰串 SHA-256 hex。
   - 名稱 `ADMIN_PASSWORD_HASH`，值係店主密碼嗰串 SHA-256 hex。
3. 儲存。改 secrets 之後唔使重新部署，即刻生效。

## 3. 推上 GitHub，自動部署

將呢啲檔案推去 `main` 分支，GitHub Actions（`.github/workflows/deploy-tryon-worker.yml`）就會自動部署。部署用嘅 `CF_API_TOKEN` 同 `CF_ACCOUNT_ID` 已經喺 GitHub Secrets 入面，唔使再加。

```bash
git add workers/tryon-api .github/workflows/deploy-tryon-worker.yml
git commit -m "Add try-on Worker API"
git push origin main
```

## 4. 搵 Worker 網址

去 Cloudflare Dashboard → **Workers & Pages** → `sugarnail-tryon-api`，入面會見到網址，格式係：

```
https://sugarnail-tryon-api.<你嘅 workers 子域名>.workers.dev
```

將呢個網址話俾負責整試甲頁嘅人知，頁面要改為 call 呢個網址嘅 `/api/...`。

## 5. 用 curl 測試（將網址換做你嗰個）

```bash
API=https://sugarnail-tryon-api.<你嘅 workers 子域名>.workers.dev

# 健康檢查
curl $API/api/health

# 客人登入（用新客人密碼；回傳會有 token 同 remaining 3）
curl -X POST $API/api/login \
  -H 'Content-Type: application/json' \
  -d '{"qr":"你張卡嘅 QR Code 內容","password":"新客人密碼"}'

# 查剩餘次數（將 TOKEN 換做上面回傳嘅 token）
curl -X POST $API/api/quota \
  -H 'Content-Type: application/json' \
  -d '{"token":"TOKEN"}'

# 提交申請（頭 3 次成功，第 4 次會回「今日額滿」）
curl -X POST $API/api/submit \
  -H 'Content-Type: application/json' \
  -d '{"token":"TOKEN","design":"布甸狗 3D"}'

# 店主登入（用新店主密碼；回傳 admin token）
curl -X POST $API/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"新店主密碼"}'

# 店主查今日用量（將 ADMIN_TOKEN 換做上面回傳嘅 token）
curl $API/api/admin/usage -H "Authorization: Bearer ADMIN_TOKEN"

# 店主查今日申請記錄
curl $API/api/admin/requests -H "Authorization: Bearer ADMIN_TOKEN"

# 店主重設某個人今日次數（將 QR 換做嗰個人嘅登入 ID）
curl -X POST $API/api/admin/reset \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{"qr":"嗰個人嘅登入 ID"}'
```

## 端點一覽

| 端點 | 用途 |
| --- | --- |
| `GET /api/health` | 健康檢查 |
| `POST /api/login` | 客人登入（QR Code＋共用密碼；TEST 無限次；回覆有客人名＋套票卡下載連結） |
| `POST /api/quota` | 查今日剩餘次數 |
| `POST /api/submit` | 記錄一次申請並扣次數（每日最多 3 次） |
| `POST /api/admin/login` | 店主登入 |
| `GET /api/admin/usage` | 今日每人用量 |
| `POST /api/admin/reset` | 重設某人今日次數做 0 |
| `GET /api/admin/requests` | 今日申請記錄（最新先行，最多 100 則） |
| `GET /api/admin/accounts` | 帳戶名單（連今日用量） |
| `POST /api/admin/accounts/create` | 開帳戶（掃 QR Code；已存在回 existed:true） |
| `POST /api/admin/accounts/update` | 改名／改狀態（active、disabled、void） |
| `POST /api/admin/accounts/delete` | 刪除帳戶 |
| `POST /api/admin/accounts/import` | CSV 匯入（每行 QR Code,客人姓名,套票卡下載連結；新增＋補名） |

帳戶可加 `passUrl`（套票卡下載連結）：開帳戶／更新／匯入都接受，客人登入後喺「我的套票卡」見到重新下載按鈕；登入頁亦會用登入 ID 即場畫返 QR Code（後備方法係用下載連結）。 |

帳戶規則：未登記嘅 QR 照樣用共用密碼登入到；有記錄而狀態係停用／作廢就唔俾登入。

## 本地測試

改完程式之後，喺 `workers/tryon-api/` 入面跑：

```bash
node test-local.mjs
```

佢會用假 KV 跑晒登入、限額、隔日重設、TEST 無限、店主用量／重設、登入限速。全部通過先推上 GitHub。
