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
| `POST /api/submit` | 客人提交試甲申請（每日最多 3 次；TEST 無限）：body `{token, design, designLink, handPhoto, refPhoto?}`，handPhoto 係 JPEG／PNG data URL（約 5MB 上限，太大回 400「相太大」）；refPhoto 係可選嘅自備參考相（同樣 JPEG／PNG data URL、約 5MB 上限，太大回 400「參考相太大」），揀咗 181 款嗰陣唔傳；回覆 `{ok:true, id, remaining}` |
| `GET /api/my-requests` | 客人用自己嘅 token 睇自己 7 日內嘅申請（最新先行；metadata＋resultImage／resultUrl，唔含手相／參考相本身；每行有 hasRefPhoto 表示有冇自備參考相） |
| `POST /api/admin/login` | 店主登入 |
| `GET /api/admin/usage` | 今日每人用量 |
| `POST /api/admin/reset` | 重設某人今日次數做 0 |
| `GET /api/admin/requests` | 最近 7 日申請記錄（最新先行，最多 100 則；metadata only，唔含手相／參考相／效果圖本身，但有 hasResult／hasResultImage／hasRefPhoto） |
| `GET /api/admin/requests/<id>` | 睇成個申請記錄（包括手相 handPhoto、自備參考相 refPhoto 同效果圖 resultImage／resultUrl）；唔存在回 404 |
| `POST /api/admin/requests/complete` | 將申請標做完成：body `{id, resultImage}`（效果圖 data URL，JPEG／PNG，約 5MB 上限）或者 `{id, resultUrl}`（https:// 連結，後備方法）；唔存在回 404 |
| `POST /api/admin/requests/cleanup` | 刪除超過 7 日嘅申請記錄（包括手相、效果圖同索引）；回覆 `{ok:true, deleted:<數目>}` |
| `POST /api/admin/test-session` | 店主用家模式專用：用 admin token 換一個 TEST 客人 session token，等店主喺用家模式可以提交申請同睇「我嘅效果圖」 |
| `POST /api/admin/ai-test` | **測試用**：用 Workers AI SDXL image-to-image 試生成一張效果圖（店主限定）；body `{image, prompt, strength?}`，回 `{ok:true, image, model}`。詳情見下面「Workers AI 測試」一節 |
| `GET /api/admin/accounts` | 帳戶名單（連今日用量） |
| `POST /api/admin/accounts/create` | 開帳戶（掃 QR Code；已存在回 existed:true） |
| `POST /api/admin/accounts/update` | 改名／改狀態（active、disabled、void） |
| `POST /api/admin/accounts/delete` | 刪除帳戶 |
| `POST /api/admin/accounts/import` | CSV 匯入（每行 QR Code,客人姓名,套票卡下載連結；新增＋補名） |

帳戶可加 `passUrl`（套票卡下載連結）：開帳戶／更新／匯入都接受，客人登入後喺「我的套票卡」見到重新下載按鈕；登入頁亦會用登入 ID 即場畫返 QR Code（後備方法係用下載連結）。

## Pass2U 同步（點樣將套票資料同步去網站）

Pass2U 模型「美甲套票」（Model ID 380564）係 6 次蓋章卡：卡面冇「剩餘次數」欄，只有「已用」數，剩餘 = 6 − 已用。條碼係系統自動產生嘅 8 位數字，就係客人登入 ID。

**同步方法（免費，唔使 API key）：** 店主去 Pass2U 票卡管理 → 撳「匯出」下載 CSV → 去試甲管理畫面「CSV 匯入」上傳嗰個檔。匯入會一次過新增／更新晒所有帳戶：客人名、已用次數、套票卡下載連結（由 passId 自動計出 `https://www.pass2u.net/d/{passId}?t=qr_code&openExternalBrowser=1`）。新客掃舖頭自動發卡 QR 拎咗新卡之後，店主再匯出匯入一次就同步埋。

**留意：** 下載連結喺張卡加入銀包之後會失效，頁面有提示叫客人搵店主再發過。完全即時自動同步要 Pass2U API key（首次免費試用 30 日，之後 NT$3,000／年）＋ webhook，未整。

登入回覆而家有 `sessionsUsed`／`sessionsLeft`，頁面「我的套票卡」會顯示「套票剩餘：X 次（已用 Y 次，共 6 次）」。

## 一鍵同步（店主撳掣，Muse 幫手做）

管理畫面「帳戶管理」有個「🔄 同步客戶資料」掣：店主撳一下，`POST /api/admin/sync-request` 會記低一個 pending 請求；Muse 每半小時檢查一次，見到請求就去 Pass2U 匯出最新 CSV 再匯入，之後 `POST /api/admin/sync-complete` 記低結果（新增／更新／總數）同清走請求。`GET /api/admin/sync-request` 俾頁面顯示「同步進行中」定「上次同步」時間。 |

帳戶規則：未登記嘅 QR 照樣用共用密碼登入到；有記錄而狀態係停用／作廢就唔俾登入。

## Workers AI 測試（唔經 Muse 生成效果圖）

目標：證明 Worker 自己收到提交嗰陣就可以生成效果圖，唔使靠 Muse 每 5 分鐘檢查。呢個係**測試階段**，正式流程未改——客人提交依然只係存申請，等 Muse 定時生成。

**端點：** `POST /api/admin/ai-test`（要 admin token；無 token 回 401）

```bash
API=https://sugarnail-tryon-api.<你嘅 workers 子域名>.workers.dev

# 店主登入拎 ADMIN_TOKEN（見上面第 5 節）
# image 用手相嘅 data URL（JPEG／PNG，約 5MB 上限）；prompt 用文字描述嗰款
curl -X POST $API/api/admin/ai-test \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{"image":"data:image/jpeg;base64,...","prompt":"paint the fingernails with a Hello Kitty bakery design, pastel blue and brown, 3D cupcakes, stars and rhinestones, keep the hands, pose, skin tone, lighting and background exactly the same","strength":0.6}'
```

成功回 `{ok:true, image:"data:image/png;base64,...", model:"@cf/stabilityai/stable-diffusion-xl-base-1.0"}`；`env.AI` 未設定（例如本地測試 mock 冇 AI）回 503「AI 未設定」；AI 出錯回 502，唔會假裝成功。

**輸入格式（已核實官方文件）：** 模型 `@cf/stabilityai/stable-diffusion-xl-base-1.0`，文件 https://developers.cloudflare.com/workers-ai/models/stable-diffusion-xl-base-1.0/。img2img 參數：`prompt`（必填文字）、`image_b64`（純 base64，唔帶 `data:` 前綴）、`strength`（0–1，預設 0.6；愈低愈貼近原相）、`num_steps`（預設 20，上限 20）、`guidance`（預設 7.5）。Binding（`env.AI.run`）回傳係 `ReadableStream` 圖片 bytes；程式亦兼容 REST 嗰種 `{image: "<base64>"}` 回覆。

**注意：**
- **SDXL 一次只食一張相加文字**：手相當輸入相，設計款式只可以用 prompt 文字描述，唔可以直接傳設計參考相入去。所以效果未必有 Muse（兩張相對照）咁貼近原款，要實測比較質素先決定用唔用。
- **⚠️ 模型計劃棄用：官方文件寫明呢個模型 Planned Deprecation 係 2026-11-20。** 測試可以照做，但正式轉用之前要搵代替模型（例如 `@cf/runwayml/stable-diffusion-v1-5-img2img`），唔好長期依賴一個就快棄用嘅模型。
- **免費額度：** Workers AI 每日免費 10,000 neurons（每日 00:00 UTC 重置），超咗要 Workers Paid 先用到，收費 $0.011／1,000 neurons。官方定價頁 https://developers.cloudflare.com/workers-ai/platform/pricing/ 冇列出 SDXL 每張幾多 neurons（模型頁寫 $0.00／step），所以每張實際用幾多要去 Dashboard → Workers AI 睇用量，唔好當實數。
- **用量唔會喺回覆入面：** binding 唔回 neuron 用量，要去 Cloudflare Dashboard 睇。
- **牆鐘限制未驗證：** SDXL 生成一張大約 15–20 秒，喺免費層 Worker 請求入面等唔等得切（免費層 CPU 上限 10ms 係計 CPU 唔計等 AI 嘅時間，但請求總時限要實機先知），要部署後實測先確認。正式流程如果改用呢個方法，應該用 `ctx.waitUntil()` 喺背景生成，唔好叫客人等成個請求。
- 設定：`wrangler.toml` 已加 `[ai] binding = "AI"`，唔使 secret，部署嗰陣自動生效。

## 效果圖 7 日保留期

- 申請記錄以提交時間（createdAt）起計保留 **7 日**。`GET /api/my-requests` 同 `GET /api/admin/requests` 只回 7 日內嘅記錄，過期嘅唔出現。
- 效果圖本身存入 KV（`resultImage` data URL，跟申請記錄一齊存），唔係只存一條 repo 連結，所以 7 日後可以一併清走。`POST /api/admin/requests/complete` 接受 `{id, resultImage}`（優先）或者 `{id, resultUrl}`（後備）。
- 清理要人手（或者之後加 cron）call `POST /api/admin/requests/cleanup`：刪除超過 7 日嘅申請記錄，包括手相、效果圖同索引，回覆 `{ok:true, deleted:<數目>}`。**而家未有自動排程去 call 呢個 endpoint**，要定期人手清，或者之後再加。
- 頁面「我嘅效果圖」寫明「效果圖保留 7 日」，每張顯示到期日（提交日＋7 日）。管理畫面申請記錄每行顯示客人個名、款名、提交時間、狀態（等緊生成／已完成）、有冇效果圖，另有「睇手相」同「睇效果圖」掣。
- 申請記錄存喺 KV，key 係 `req:<香港日期>:<時間戳>-<隨機碼>`，日期前綴就係索引；cleanup 刪走 key 本身就等於清埋索引。舊版（未有呢次改動之前）提交嘅記錄冇 `id`／`createdAt`，用 `ts` 做後備，7 日內會自然過期，detail／complete 會回 404。

## 本地測試

改完程式之後，喺 `workers/tryon-api/` 入面跑：

```bash
node test-local.mjs
```

佢會用假 KV 跑晒登入、限額、隔日重設、TEST 無限、店主用量／重設、登入限速。全部通過先推上 GitHub。
