#!/usr/bin/env python3
"""由 Instagram API 攞最新 Post，合併入 data/feed.json。

用法：
    IG_ACCESS_TOKEN=<長效 token> python3 scripts/fetch_ig.py [--max-pages 4]

- 只用 Instagram API with Instagram Login（graph.instagram.com），
  權限只需要 instagram_business_basic（讀自己帳號嘅 Post）。
  唔用已死嘅 Basic Display API，唔使 Facebook 專頁，唔使 App Review。
- 唔攞 like_count，唔存 Like 數（公開網站唔顯示）。
- 新 Post 嘅相會下載去 assets/images/<media_id>.jpg（最多 20 張／次），
  舊 Post 唔會重新下載；下載唔到就用 API 俾嘅 media_url 頂住。
- API 失敗（例如 token 過期）唔會刪舊 feed：照舊寫返原有 feed.json，
  只係印錯誤、exit code 2，等人手／下次再試。網站唔會因此變空白。

環境變數（唔好寫入 code / git）：
    IG_ACCESS_TOKEN   長效 token（60 日，見 scripts/refresh_token.py）
    IG_USER_ID        選填；唔填就用 /me 自動攞
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, str(__file__.rsplit("/", 1)[0]))
from common import (  # noqa: E402
    API_BASE,
    DATA_DIR,
    ASSETS_DIR,
    categories_for,
    load_categories,
    load_feed,
    save_json,
    shortcode_from_permalink,
)

FIELDS = (
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,"
    "children{id,media_type,media_url,thumbnail_url}"
)
MAX_POSTS = 200          # feed.json 最多留幾多則
MAX_DOWNLOADS_PER_RUN = 20


def api_get(url: str, params: dict) -> dict:
    import json as _json

    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "sugar-nail-sync/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return _json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"API 錯誤 HTTP {e.code}: {body[:500]}", file=sys.stderr)
        raise SystemExit(2)


def pick_image(item: dict) -> str:
    """揀一張代表相：相 > 影片縮圖 > 輪播第一張相。"""
    media_type = item.get("media_type", "")
    if media_type == "VIDEO":
        return item.get("thumbnail_url") or item.get("media_url") or ""
    if media_type == "CAROUSEL_ALBUM":
        for child in item.get("children", {}).get("data", []):
            if child.get("media_type") in ("IMAGE", "CAROUSEL_ALBUM"):
                return child.get("media_url") or ""
        return item.get("media_url") or ""
    return item.get("media_url") or item.get("thumbnail_url") or ""


def download_image(url: str, dest) -> bool:
    if not url:
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sugar-nail-sync/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if len(data) < 1024:  # 太細，唔似係一張相
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return True
    except Exception as e:  # 下載失敗唔好成個 sync 死：用返 media_url
        print(f"  下載相失敗 {url[:80]}: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pages", type=int, default=4)
    args = ap.parse_args()

    token = os.environ.get("IG_ACCESS_TOKEN", "").strip()
    if not token:
        print("錯誤：未設定 IG_ACCESS_TOKEN。見 SETUP.md 第 3 步攞長效 token。", file=sys.stderr)
        return 2

    me = api_get(f"{API_BASE}/me", {
        "fields": "id,username,account_type,media_count",
        "access_token": token,
    })
    ig_user_id = os.environ.get("IG_USER_ID") or me.get("id")
    print(f"帳號：@{me.get('username')}（{me.get('account_type')}，"
          f"media_count={me.get('media_count')}）")

    # 分頁攞最新 Post
    fetched: list[dict] = []
    url = f"{API_BASE}/{ig_user_id}/media"
    params = {"fields": FIELDS, "limit": 50, "access_token": token}
    for _ in range(args.max_pages):
        page = api_get(url, params)
        fetched.extend(page.get("data", []))
        nxt = (page.get("paging") or {}).get("next")
        if not nxt or len(fetched) >= MAX_POSTS:
            break
        url, params = nxt.split("?", 1)[0], dict(
            urllib.parse.parse_qsl(urllib.parse.urlsplit(nxt).query)
        )
    print(f"API 攞到 {len(fetched)} 則")

    feed = load_feed()
    overrides = load_categories()
    by_key = {}
    for p in feed.get("posts", []):
        by_key[p.get("id") or p.get("shortcode")] = p

    new_count = 0
    downloads = 0
    for item in fetched:
        media_id = item["id"]
        shortcode = shortcode_from_permalink(item.get("permalink", ""))
        image_url = pick_image(item)
        post = by_key.get(media_id) or by_key.get(shortcode) or {}
        is_new = media_id not in by_key and shortcode not in by_key
        post.update({
            "id": media_id,
            "shortcode": shortcode,
            "permalink": item.get("permalink", ""),
            "caption": item.get("caption", ""),
            "media_type": item.get("media_type", ""),
            "timestamp": item.get("timestamp", ""),
            "image": image_url,
        })
        # 新 Post：下載張相落地，唔好長期依賴 IG CDN 連結（會過期）
        if is_new and image_url and downloads < MAX_DOWNLOADS_PER_RUN:
            dest = ASSETS_DIR / "images" / f"{media_id}.jpg"
            if not dest.exists() and download_image(image_url, dest):
                post["local_image"] = f"assets/images/{media_id}.jpg"
                downloads += 1
        if is_new:
            new_count += 1
        post["categories"] = categories_for(post, overrides)
        by_key[media_id] = post

    posts = sorted(
        by_key.values(),
        key=lambda p: p.get("timestamp") or "",
        reverse=True,
    )[:MAX_POSTS]
    feed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "instagram-api-v25.0",
        "posts": posts,
    }
    save_json(DATA_DIR / "feed.json", feed)
    print(f"完成：新增 {new_count} 則，下載咗 {downloads} 張新相，"
          f"feed.json 而家有 {len(posts)} 則")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
