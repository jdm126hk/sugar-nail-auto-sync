#!/usr/bin/env python3
"""由 data/feed.json 生成靜態網站去 public/（Cloudflare Pages 部署目錄）。

用法：python3 scripts/build_site.py [--out public]

- 讀 templates/index.html，換走 <!--GALLERY--> 做作品牆 HTML。
- 公開輸出唔含：價錢、Like 數、日期、作品總數、套票／會員／Pass2U。
  feed.json 入面嘅 timestamp / caption 唔會寫入公開 HTML；
  public/feed.json 係去咗 timestamp 嘅版本。
- 相：有 local_image 用本地（assets/images/），冇就用 image URL。
- 檢查：輸出有禁字就失敗，唔好將錯嘅站發佈出去。
"""
from __future__ import annotations

import argparse
import html
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(__file__.rsplit("/", 1)[0]))
from common import (  # noqa: E402
    ASSETS_DIR,
    CATEGORIES,
    CATEGORY_ORDER,
    DATA_DIR,
    ROOT,
    load_categories,
    load_feed,
    save_json,
)

FORBIDDEN = ["套票", "會員", "Pass2U", "pass2u", "價錢表", "$", "HK$"]
BATCH = 20  # 首批顯示幾多格，其餘㩒「顯示更多」


def tile(post: dict) -> str:
    cats = [c for c in post.get("categories", ["other"]) if c in CATEGORIES]
    if not cats:
        cats = ["other"]
    data_cat = " ".join(cats)
    label = "、".join(CATEGORIES[c] for c in cats)
    style = (post.get("style") or "").strip()
    alt = f"Sugar Nail 作品：{style}" if style else "Sugar Nail 作品"
    img = post.get("local_image") or post.get("image", "")
    return (
        f'<a class="p-tile" href="{html.escape(post["permalink"])}" '
        f'target="_blank" rel="noopener" data-cat="{data_cat}">'
        f'<img src="{html.escape(img)}" alt="{html.escape(alt)}" '
        f'loading="lazy"><span class="p-cat">{html.escape(label)}</span></a>'
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public")
    args = ap.parse_args()

    out = ROOT / args.out
    feed = load_feed()
    posts = feed.get("posts", [])
    if not posts:
        print("錯誤：data/feed.json 冇 Post，先跑 scripts/seed_from_catalogue.py",
              file=sys.stderr)
        return 2

    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    gallery = "\n".join(tile(p) for p in posts)
    page = template.replace("<!--GALLERY-->", gallery)

    # 用戶 2026-11-12 明確要求嘅登入 ID 寫法「套票卡上面 QR Code 下面的號碼」
    # 係唯一獲准出現嘅「套票」字眼，檢查前先剔走佢；其他套票提及照樣擋。
    check_page = page.replace("套票卡上面 QR Code 下面的號碼", "")
    for word in FORBIDDEN:
        if word in check_page:
            print(f"錯誤：輸出含有禁字 {word!r}，停止 build。", file=sys.stderr)
            return 2

    if out.exists():
        shutil.rmtree(out)
    (out / "assets").mkdir(parents=True)
    (out / "index.html").write_text(page, encoding="utf-8")

    # Logo 同新下載嘅相一齊 copy 去 public/
    for name in ("logo-transparent.png", "logo-transparent-small.png"):
        src = ASSETS_DIR / name
        if src.exists():
            shutil.copy2(src, out / "assets" / name)
    images = ASSETS_DIR / "images"
    if images.exists():
        shutil.copytree(images, out / "assets" / "images")
    # 招牌相（seed 用）喺 workspace 另一邊，喺呢度留返個 pompom.jpg 位置：
    # 如果 repo 入面有 assets/pompom.jpg 就 copy，冇就唔理（用返 IG 圖片端點）。
    for pom in (ASSETS_DIR / "pompom.jpg",
                Path.home() / "workspace/sugar-nail/assets/pompom.jpg"):
        if pom.exists():
            shutil.copy2(pom, out / "assets" / "pompom.jpg")
            break

    # 試甲頁（tryon/index.html 係 artifact 匯出嘅獨立頁，駁咗 Worker API），
    # 每次 build 都一齊 copy 去 public/tryon/，唔好直接放喺 public/ 入面，
    # 因為上面開頭會成個 public/ 刪咗再起。
    tryon_src = ROOT / "tryon" / "index.html"
    if tryon_src.exists():
        (out / "tryon").mkdir(parents=True, exist_ok=True)
        shutil.copy2(tryon_src, out / "tryon" / "index.html")

    # 公開版 feed.json：唔含 timestamp（唔顯示日期）
    public_feed = {
        "posts": [
            {
                "shortcode": p.get("shortcode"),
                "permalink": p.get("permalink"),
                "image": p.get("local_image") or p.get("image"),
                "categories": p.get("categories", ["other"]),
                "style": p.get("style", ""),
            }
            for p in posts
        ]
    }
    save_json(out / "feed.json", public_feed)
    print(f"完成：public/index.html 有 {len(posts)} 格作品，"
          f"分類：{ {c: sum(1 for p in posts if c in p.get('categories', [])) for c in CATEGORY_ORDER} }")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
