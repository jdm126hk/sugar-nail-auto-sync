"""Sugar Nail IG 自動同步 — 共用工具（Python 標準庫，零依賴）。

公開網站規則（唔好改）：
- 唔顯示價錢、Like 數、日期、作品總數
- 唔提套票／會員／Pass2U
- 新 Post 未分類一律歸「簡約／其他」
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ASSETS_DIR = ROOT / "assets"

API_VERSION = "v25.0"  # Meta Graph API 最新版（2026 年核實）；改版時只改呢個常數
API_BASE = f"https://graph.instagram.com/{API_VERSION}"

# 分類代碼 -> 公開顯示名
CATEGORIES = {
    "hand": "全手繪卡通",
    "3d": "3D 粉雕",
    "cat": "貓眼",
    "mirror": "鏡面",
    "other": "簡約／其他",
}
CATEGORY_ORDER = ["hand", "3d", "cat", "mirror", "other"]

# 由 caption 關鍵字估分類。caption 好多時得 hashtag / 冇字，
# 估唔到就歸 other，唔好估錯好過估錯分類。
KEYWORDS = {
    "hand": ["手繪", "卡通", "公仔", "Hello Kitty", "布甸狗", "Pompompurin",
             "波兒", "卡西火", "蜘蛛俠", "小圓", "維尼", "茶餐廳", "花生"],
    "3d": ["3D", "粉雕", "立體", "粉雕"],
    "cat": ["貓眼"],
    "mirror": ["鏡面", "鉻面", "極光", "鏡"],
}


def shortcode_from_permalink(permalink: str) -> str:
    """https://www.instagram.com/p/Dfjh7oAPJP5/ -> Dfjh7oAPJP5"""
    m = re.search(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)", permalink or "")
    return m.group(1) if m else ""


def classify(caption: str, style: str = "") -> list[str]:
    """由 caption / 款式描述估分類（可多個，例如鏡面＋貓眼）。"""
    text = f"{caption or ''} {style or ''}"
    found: list[str] = []
    for code, words in KEYWORDS.items():
        if any(w in text for w in words):
            found.append(code)
    # 「鏡」字太濫（例如「鏡頭」），但 caption 入面出現多數都係講鏡面；
    # 只有「鏡」字而無「鏡面／鉻面／極光」時，唔單獨算 mirror。
    if "mirror" in found and not any(
        w in text for w in ["鏡面", "鉻面", "極光"]
    ):
        found.remove("mirror")
    return found or ["other"]


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def load_categories() -> dict:
    """data/categories.json：{shortcode: [分類代碼]}，人手覆寫，優先於自動估算。"""
    return load_json(DATA_DIR / "categories.json", {})


def load_feed() -> dict:
    return load_json(DATA_DIR / "feed.json", {"posts": []})


def categories_for(post: dict, overrides: dict) -> list[str]:
    shortcode = post.get("shortcode") or shortcode_from_permalink(
        post.get("permalink", "")
    )
    if shortcode in overrides:
        cats = [c for c in overrides[shortcode] if c in CATEGORIES]
        if cats:
            return cats
    return classify(post.get("caption", ""), post.get("style", ""))
