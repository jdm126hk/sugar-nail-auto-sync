# Sugar Nail — IG 自動同步網站（免費版）

唔用 WordPress、唔使錢嘅做法：IG 出新 Post，網站作品牆自動更新。

- **網站**：`https://sugarnail.pages.dev`（Cloudflare Pages 免費計劃）
- **自動同步**：GitHub Actions 每日定時跑一次（免費額度），另可手動觸發
- **IG 串接**：Instagram API with Instagram Login（`graph.instagram.com`），
  唔用已死嘅 Basic Display API，唔使 Facebook 專頁，唔使 App Review
- **成本**：$0

## 點運作

```
IG 出新 Post
  → 每日 10:00（香港時間）GitHub Actions 自動跑
    1. refresh_token.py：個 token 用咗 30 日或以上就續（長效 token 有效 60 日）
    2. fetch_ig.py：由 IG API 攞最新 Post，新相下載落地
    3. build_site.py：重新生成靜態網站去 public/
    4. commit feed.json + 新相返 repo
    5. Wrangler deploy 去 Cloudflare Pages
  → https://sugarnail.pages.dev 自動多咗新作品
```

## 檔案結構

```
scripts/          Python 工具（標準庫，零依賴）
templates/        網站模板（Hero、作品牆、服務、預約、聯絡、FAQ）
.github/workflows/  sync.yml（每日定時 + 手動觸發）
data/             feed.json、categories.json（由 script 生成）
assets/           Logo、招牌相、新下載嘅 IG 相
wrangler.toml     Cloudflare Pages 設定（project 名 sugarnail）
```

## 快速開始

照 [SETUP.md](SETUP.md) 一步步做：開 Meta developer app → 授權 IG 攞
長效 token → 放 GitHub Secrets → 開 Cloudflare Pages project
`sugarnail` → 第一次手動跑 workflow。

本地試 build（唔使 token）：

```bash
python3 scripts/seed_from_catalogue.py
python3 scripts/build_site.py
# 輸出喺 public/，用瀏覽器開 public/index.html 睇得
```

## 公開網站規則

- 唔顯示收費、Like 數、日期、作品總數
- 唔提套票／會員／Pass2U
- 新 Post 未分類一律歸「簡約／其他」
- `build_site.py` 會檢查禁字，有禁字就失敗，唔會發佈錯嘅站

## 限制（要知道）

- GitHub 免費 cron 有時會遲幾個鐘；趕住就手動 Run workflow。
- 長效 token 有效 60 日，靠每日 workflow 續；如果 60 日內完全冇續過，
  個 token 會死，要重新授權一次（見 SETUP.md 第 6 步）。
- 冇 `GH_PAT` secret 嘅話，續咗 token 之後要人手更新
  `IG_ACCESS_TOKEN` secret。
- 呢個係靜態展示網站，唔係 WordPress：冇後台、冇網上商店。
  商店（WooCommerce）要等 WordPress 真站，見
  `~/workspace/sugar-nail/wordpress/`。
