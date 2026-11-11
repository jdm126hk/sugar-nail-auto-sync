#!/usr/bin/env python3
"""由內部目錄 ~/workspace/sugar-nail/site-updates/作品-181則-目錄.md
生成 data/feed.json 同 data/categories.json（第一次設定用，一次過）。

- 最近 50 則：目錄有日期＋分類＋款式描述，照抄。
- 其餘 131 則：只有連結，分類歸「簡約／其他」，唔估款式、唔估日期。
- 相：用 Instagram 官方圖片端點 https://www.instagram.com/p/<code>/media/?size=l，
  唔使下載 181 張相都睇到；之後 API 攞到新 Post 會下載落地。
- 招牌款（2026-10-01 布甸狗 Dd8xuoSvhGT）用本地 assets/pompom.jpg。
- 唔攞 Like 數，唔寫 Like 數入 feed.json。
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(__file__.rsplit("/", 1)[0]))
from common import DATA_DIR, save_json  # noqa: E402

CATALOGUE = Path.home() / "workspace/sugar-nail/site-updates/作品-181則-目錄.md"
HERO_SHORTCODE = "Dd8xuoSvhGT"

TABLE_CAT = {
    "全手繪卡通": ["hand"],
    "3D 粉雕": ["3d"],
    "貓眼": ["cat"],
    "鏡面": ["mirror"],
    "簡約／其他": ["other"],
}


def extra_categories(style: str, base: list[str]) -> list[str]:
    """由款式描述加第二屬性，例如「鏡面＋貓眼」「全手繪，兼貓眼」。"""
    cats = list(base)
    if "鏡面" in style or "鉻面" in style:
        if "mirror" not in cats:
            cats.append("mirror")
    if "貓眼" in style and "cat" not in cats:
        cats.append("cat")
    if "手繪" in style and "hand" not in cats:
        cats.append("hand")
    if "3D" in style and "3d" not in cats:
        cats.append("3d")
    return cats


def main() -> int:
    text = CATALOGUE.read_text(encoding="utf-8")
    posts: dict[str, dict] = {}
    categories: dict[str, list[str]] = {}

    # 最近 50 則表格：| # | 日期 | 連結 | Like | 分類 | 款式 |
    for m in re.finditer(
        r"\|\s*\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*"
        r"(https://www\.instagram\.com/p/([A-Za-z0-9_-]+)/)\s*\|[^|]*\|"
        r"\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|",
        text,
    ):
        date, permalink, code, cat_name, style = m.groups()
        cats = extra_categories(style.strip(), TABLE_CAT.get(cat_name.strip(), ["other"]))
        posts[code] = {
            "id": f"seed-{code}",
            "shortcode": code,
            "permalink": permalink,
            "caption": "",
            "media_type": "IMAGE",
            "timestamp": f"{date}T00:00:00+00:00",
            "image": (
                "assets/pompom.jpg"
                if code == HERO_SHORTCODE
                else f"https://www.instagram.com/p/{code}/media/?size=l"
            ),
            "style": style.strip(),
            "categories": cats,
        }
        categories[code] = cats

    # 其餘 131 則：只有連結
    for m in re.finditer(
        r"https://www\.instagram\.com/p/([A-Za-z0-9_-]+)/", text
    ):
        code = m.group(1)
        if code not in posts:
            posts[code] = {
                "id": f"seed-{code}",
                "shortcode": code,
                "permalink": f"https://www.instagram.com/p/{code}/",
                "caption": "",
                "media_type": "IMAGE",
                "timestamp": "",
                "image": f"https://www.instagram.com/p/{code}/media/?size=l",
                "style": "",
                "categories": ["other"],
            }
            categories[code] = ["other"]

    ordered = sorted(
        posts.values(), key=lambda p: p.get("timestamp") or "", reverse=True
    )
    # 冇日期嘅放後面，保持目錄原有順序（由新至舊）已由 timestamp 排序近似
    feed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "seed-catalogue-2026-11-11",
        "posts": ordered,
    }
    save_json(DATA_DIR / "feed.json", feed)
    save_json(DATA_DIR / "categories.json", categories)
    print(f"完成：feed.json 有 {len(ordered)} 則，"
          f"有分類＋款式嘅 {sum(1 for p in ordered if p['style'])} 則，"
          f"其餘歸「簡約／其他」")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
