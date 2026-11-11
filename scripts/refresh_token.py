#!/usr/bin/env python3
"""續 Instagram 長效 token（60 日）。

用法：
    IG_ACCESS_TOKEN=<舊長效 token> python3 scripts/refresh_token.py [--force]

Meta 規則（2026 年核實）：
- 長效 token 有效 60 日；要喺未過期、而且已經用咗至少 24 小時之後
  先可以續，續完又係一個新嘅 60 日 token。
- 60 日內完全冇續過，token 會死，續唔返，要用戶重新登入授權一次。
- 所以呢個 script 預設只會喺 token 已經用咗 30 日或以上先續，
  每日跑一次都唔會浪費；--force 會跳過 30 日檢查（例如第一次設定）。

安全：
- 新 token 只會印遮咗嘅版本去 log，絕對唔寫入 git、唔寫入任何檔案。
- 喺 GitHub Actions 入面，新 token 會寫去 $GITHUB_OUTPUT（已遮罩），
  由 workflow 用 `gh secret set` 更新返 GitHub Secret IG_ACCESS_TOKEN。
  本地跑嗰陣，請人手將新 token 貼去 GitHub Secrets（見 SETUP.md）。

data/token_meta.json 只記低「幾時換過 token、幾時到期」，唔記 token 本身。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(__file__.rsplit("/", 1)[0]))
from common import API_BASE, DATA_DIR  # noqa: E402

META_PATH = DATA_DIR / "token_meta.json"
REFRESH_AFTER_DAYS = 30


def load_meta() -> dict:
    try:
        return json.loads(META_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def mask(token: str) -> str:
    return token[:4] + "…" + token[-4:] if len(token) > 8 else "****"


def main() -> int:
    force = "--force" in sys.argv
    token = os.environ.get("IG_ACCESS_TOKEN", "").strip()
    if not token:
        print("錯誤：未設定 IG_ACCESS_TOKEN。", file=sys.stderr)
        return 2

    meta = load_meta()
    issued = meta.get("issued_at")
    if issued and not force:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(issued)
            if age < timedelta(days=REFRESH_AFTER_DAYS):
                print(f"Token 仲新（用咗 {age.days} 日），未到 30 日，今次唔續。")
                return 0
        except ValueError:
            pass

    url = (f"{API_BASE}/refresh_access_token?"
           + urllib.parse.urlencode({
               "grant_type": "ig_refresh_token",
               "access_token": token,
           }))
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        # 未夠 24 小時就唔俾續：唔係錯，過幾日再試就得
        if "not old enough" in body or "24" in body:
            print("Token 未夠 24 小時，Meta 唔俾續住，過幾日再試。")
            return 0
        print(f"續 token 失敗 HTTP {e.code}: {body[:500]}", file=sys.stderr)
        print("如果係 token 已過期（60 日冇續），要重新授權：見 SETUP.md 第 3 步。", file=sys.stderr)
        return 2

    new_token = data.get("access_token", "")
    expires_in = int(data.get("expires_in", 5184000))  # 約 60 日
    if not new_token:
        print(f"續 token 回應異常：{data}", file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    meta.update({
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=expires_in)).isoformat(),
        "expires_in_days": round(expires_in / 86400, 1),
    })
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    print(f"續咗 token：{mask(new_token)}，有效約 {expires_in // 86400} 日，"
          f"到期 {meta['expires_at'][:10]}。")

    # 交俾 GitHub Actions workflow 更新 Secret（新 token 唔會寫入檔案）
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        print(f"::add-mask::{new_token}")
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"new_token={new_token}\n")
            f.write(f"expires_in={expires_in}\n")
    else:
        print("本地模式：請人手將上面嗰個新 token 貼去 GitHub Secrets "
              "IG_ACCESS_TOKEN（唔好貼入任何檔案／唔好傳俾人）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
