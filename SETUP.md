# Sugar Nail IG 自動同步 — 設定指南（免費版）

成個系統係 **$0**：GitHub Actions（免費額度）每日定時跑一次，
Cloudflare Pages（免費計劃）放網站。唔使 WordPress，唔使買任何嘢。

流程好簡單：你喺 IG 出新 Post → 第二朝網站自動多咗嗰格 → 唔使人手做嘢。

> ⚠️ 下面有幾步一定要你親手做，Muse 幫唔到你做：登入你自己嘅 Meta
> 帳號授權、攞 token、將 token 貼去 GitHub Secrets、開 Cloudflare
> 帳號。Token 同密碼一樣，**千祈唔好貼入對話、唔好寫入任何檔案**，
> 只可以貼去 GitHub Secrets。

---

## 第 0 步：呢個資料夾係咩

```
auto-sync/
├── scripts/          Python 工具（標準庫，零依賴，唔使 pip install）
│   ├── common.py             分類、讀寫 JSON
│   ├── fetch_ig.py           由 IG API 攞最新 Post
│   ├── refresh_token.py      續長效 token
│   ├── seed_from_catalogue.py 第一次設定用：由內部目錄生成 181 則 feed
│   └── build_site.py         由 feed 生成靜態網站去 public/
├── templates/index.html      網站模板（Hero、作品牆、服務、預約、聯絡、FAQ）
├── .github/workflows/sync.yml 每日定時 + 手動觸發嘅自動同步
├── wrangler.toml             Cloudflare Pages 設定（project 名 sugarnail）
├── .env.example              本地設定範本
└── data/                     feed.json、categories.json（由 script 生成）
```

公開網站規則（寫死咗喺 `scripts/build_site.py`，有禁字會直接失敗唔發佈）：
唔顯示收費、Like 數、日期、作品總數；唔提套票／會員／Pass2U。

---

## 第 1 步：開 Meta developer app

1. 去 <https://developers.facebook.com/>，用你嘅 Facebook 帳號登入。
2. 右上角「My Apps」→「Create App」。
3. 揀「Other」→「Next」→ 類型揀「Business」→ 填 App 名（例如 `Sugar Nail IG Sync`）→ Create。
4. 左邊選單「Add Product」，搵「Instagram API with Instagram Login」，撳「Set up」。
   - 唔好揀舊嘅「Instagram Basic Display」，佢已經死咗（2024 年 12 月 4 日停用）。
   - 呢個新做法唔使連結 Facebook 專頁，唔使 App Review（只係讀自己帳號）。
5. 記低 App Dashboard 嘅 **App ID** 同 **App Secret**（撳「Show」先睇到）。
   App Secret 等於密碼，唔好貼去任何公開地方。

## 第 2 步：授權 IG 帳號，攞長效 token

你個 IG 帳號 `@sugar_nail2008` 已經係 Creator（專業帳號），符合 API 要求。
個人帳號用唔到呢個 API。

1. 去 <https://developers.facebook.com/tools/explorer/>（Graph API Explorer）。
2. 右上角揀返第 1 步開嘅 app。
3. 「Add a Permission」→ 揀 `instagram_business_basic` →「Generate Access Token」。
4. 瀏覽器會彈出授權畫面：登入 **sugar_nail2008** 嗰個 IG 帳號，撳允許。
   （如果彈出嚟係第二個帳號，例如 jm_design_productions，要先登出再登入
   sugar_nail2008 先授權。）
5. 攞到嘅係短效 token（得幾個鐘）。喺瀏覽器開呢條連結換成長效 token
   （60 日），將下面三個位換成你自己嘅值：

   ```
   https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=你嘅APP_SECRET&access_token=頭先嗰個短效TOKEN
   ```

   回應會有 `access_token`（長效 token）同 `expires_in`（約 5184000 秒 = 60 日）。
   呢個就係之後要用嘅 token。

## 第 3 步：開 GitHub repo，放 Secrets

1. 去 <https://github.com/new> 開一個新 repo，例如 `sugar-nail-auto-sync`。
   Public 定 Private 都得（Private 都一樣免費跑 Actions）。
2. 將 `auto-sync/` 入面嘅檔案推上去（唔包括 `public/`，佢係 build 出嚟嘅，
   已經喺 `.gitignore` 入面；更加唔好推 `.env`，如果你有開過）。
3. 去 repo →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」，
   逐個加：

   | Secret 名 | 內容 |
   |---|---|
   | `IG_ACCESS_TOKEN` | 第 2 步攞到嘅長效 token |
   | `IG_APP_ID` | 第 1 步嘅 App ID |
   | `IG_APP_SECRET` | 第 1 步嘅 App Secret |
   | `CF_API_TOKEN` | 第 4 步嘅 Cloudflare API token |
   | `CF_ACCOUNT_ID` | 第 4 步嘅 Cloudflare 帳號 ID |
   | `GH_PAT` | 選填，見下面 |
   | `IG_USER_ID` | 選填，唔填就用 `/me` 自動攞 |

   **GH_PAT 係咩？** 每日 workflow 續 token 之後，要將新 token 寫返去
   `IG_ACCESS_TOKEN` secret。GitHub 預設嘅 `GITHUB_TOKEN` 係改唔到
   Secrets 嘅，所以要有一個你自己開嘅 Personal Access Token 先做到
   自動更新：
   - 去 GitHub → 頭像 → Settings → Developer settings → Personal access
     tokens → Fine-grained tokens → Generate new token，揀返呢個 repo，
     權限開 `secrets: write`（Administration → Secrets 讀寫）。
   - 將佢貼去 secret `GH_PAT`。
   - 如果唔開 `GH_PAT`，系統一樣會跑，只係續咗 token 之後要你人手貼返
     新 token 去 `IG_ACCESS_TOKEN` secret，workflow 會喺 log 度提醒你。

## 第 4 步：開 Cloudflare Pages project `sugarnail`

1. 去 <https://dash.cloudflare.com/> 開免費帳號登入。
2. 左邊「Workers & Pages」→「Create」→「Pages」→「Connect to Git」，
   連接 GitHub，揀第 3 步嗰個 repo。
   - Framework preset：揀「None」或者留空，唔使 build command。
   - Build output directory：填 `public`。
   - 第一次可以唔使等佢 deploy，因為每日 workflow 會自己 deploy。
3. Project 名一定要打 `sugarnail`，先會攞到
   `https://sugarnail.pages.dev`。先到先得，有人用咗就冇。
   （查過：呢個名暫時未有人用。）
4. 攞 API token 做 deploy 用：
   - Cloudflare Dashboard → 右上角頭像 →「My Profile」→「API Tokens」
     →「Create Token」→ 用「Edit Cloudflare Workers」範本，
     權限要有 Account 讀取 + Pages 編輯。
   - 將 token 貼去 GitHub secret `CF_API_TOKEN`，帳號 ID 貼去
     `CF_ACCOUNT_ID`（喺 Workers & Pages 頁面右邊搵到）。

## 第 5 步：第一次部署

1. 去 GitHub repo →「Actions」→ 左邊「IG auto-sync」→「Run workflow」
   →「Run workflow」，等佢跑完（約 1–2 分鐘）。
2. 跑完去 <https://sugarnail.pages.dev> 睇下，應該見到同展示版一樣
   嘅網站，作品牆有晒啲相。
3. 之後每日香港時間朝早 10 點（UTC 02:00）會自動跑一次。有新 Post
   就會自動加落網站，冇新 Post 就咩都唔改。

### 本地第一次部署（唔用 GitHub Actions 都得）

```bash
cd auto-sync
cp .env.example .env   # 填好 CF_API_TOKEN、CF_ACCOUNT_ID
python3 scripts/seed_from_catalogue.py   # 只係第一次要跑，生成 181 則 feed
python3 scripts/build_site.py           # 生成 public/
npx --yes wrangler@4 pages deploy public --project-name sugarnail
```

## 第 6 步：Token 60 日到期，點算？

- 長效 token 有效 **60 日**。`refresh_token.py` 會喺 token 用咗
  **30 日或以上**嗰陣自動續，續完又係一個新嘅 60 日 token。
  所以只要每日 workflow 有正常跑，token 理論上永遠唔會死。
- 但係有兩個情況要你親手做：
  1. **60 日內完全冇續過**（例如 workflow 停咗兩個月、或者
     `GH_PAT` 冇設定又冇人手更新 secret）：個 token 會死，續唔返。
     要由第 2 步重新授權一次，攞個新長效 token，再貼去
     `IG_ACCESS_TOKEN` secret。
  2. **續咗但 secret 未更新**（冇 `GH_PAT`）：workflow 會喺 log 度
     出警告，話你知要人手貼新 token。舊 token 未到期之前網站
     唔會停，但係唔好拖到過期先處理。
- 點知 token 幾時到期？`data/token_meta.json` 會記低上次換 token
  嘅日子同到期日（入面冇 token 本身，可以放心 commit）。
  唔好等到 workflow 失敗先睇，每個月望一次 Actions 嘅綠剔就得。

## 第 7 步：GitHub cron 有時會遲

GitHub 免費 cron 唔係鬧鐘，佢有時會遲幾個鐘先跑，呢個係 GitHub
本身嘅限制，唔係個系統壞咗。趕住出新 Post（例如出咗新款想即刻
俾客睇）就去 Actions 頁面手動「Run workflow」跑一次，跑完 1–2
分鐘內網站就會更新。

---

## 常見問題

**Q：出咗新 Post，網站幾時先見到？**
A：下一次 workflow 跑嗰陣（每日朝早 10 點，或者你手動跑）。新 Post
嘅相會下載去 `assets/images/`，之後就唔使再依賴 IG 嗰條會過期嘅
圖片連結。

**Q：新 Post 嘅分類啱唔啱？**
A：系統會由 caption 關鍵字估分類（手繪／卡通／3D／貓眼／鏡面），
估唔到就歸「簡約／其他」。想改某則嘅分類，改 `data/categories.json`
入面嗰個 shortcode 嘅分類，之後 workflow 會優先用你改嘅版本。
（分類只可以係 `hand`、`3d`、`cat`、`mirror`、`other`。）

**Q：workflow 失敗，點算？**
A：去 Actions 睇紅色嗰個 run 嘅 log。最常見：
- `未設定 IG_ACCESS_TOKEN`：Secret 未設定或者打錯名。
- `續 token 失敗 / API 錯誤 HTTP 400`：token 過期，要由第 2 步重新授權。
- `CLOUDFLARE_API_TOKEN` 錯：Cloudflare token 權限唔夠或者過期。
- 其餘錯誤唔會刪舊 feed，網站會繼續顯示上一次成功嘅版本，唔會變空白。

**Q：我想改網站版面／文字，點做？**
A：改 `templates/index.html`，再跑 `python3 scripts/build_site.py`，
之後 workflow 會自己 deploy。記住公開輸出唔可以有收費、Like 數、
日期、作品總數、套票／會員／Pass2U 字眼，`build_site.py` 會檢查，
有禁字會直接失敗。

**Q：之後買咗正式域名，點轉？**
A：域名買返嚟之後，去 Cloudflare Pages project →「Custom domains」
→「Set up a custom domain」，打返你個域名，照指示加 DNS 紀錄就得。
`templates/index.html` 入面嘅 `og:image` 同 JSON-LD 嗰啲
`sugarnail.pages.dev` 要一併改做新域名，再跑一次 workflow。
