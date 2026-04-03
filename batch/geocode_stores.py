"""
geocode_stores.py  ─  Supabase の stores テーブルの住所から
                       緯度経度を自動取得して一括更新する

【使い方】
  batch/ フォルダで実行:
    python geocode_stores.py

【仕組み】
  Nominatim（OpenStreetMap の無料ジオコーダー）を使用。
  APIキー不要。1秒に1回のリクエスト制限があるため自動でウェイトを入れます。

【注意】
  - 住所が正確でないと座標がずれます
  - 実行後に地図で確認することをおすすめします
  - --dry-run オプションで更新せずに確認だけできます
"""

import asyncio
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from supabase import create_client

# ── 設定 ──────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
WAIT_SEC = 1.1   # Nominatim の利用規約: 1秒に1リクエスト


def main():
    load_dotenv(BASE_DIR / ".env")
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  .env に SUPABASE_URL と SUPABASE_SERVICE_KEY を設定してください")
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("=== DRY RUN モード（Supabase は更新しません）===\n")

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK\n")

    # 全店舗を取得
    res = supabase.table("stores").select("id, name, address, lat, lng").execute()
    stores = res.data or []
    print(f"対象店舗: {len(stores)} 件\n")
    print(f"{'店舗名':<30} {'現在の座標':<30} {'新しい座標':<30} 状態")
    print("-" * 110)

    updated = 0
    failed = 0

    for store in stores:
        name    = store["name"]
        address = store.get("address", "")
        old_lat = store.get("lat")
        old_lng = store.get("lng")

        if not address:
            print(f"{name:<30} {'住所なし → スキップ'}")
            failed += 1
            continue

        # Nominatim でジオコーディング
        new_lat, new_lng, display = geocode(address)

        if new_lat is None:
            # 住所で失敗したら店舗名でリトライ
            print(f"  住所で失敗、店舗名でリトライ: {name}")
            new_lat, new_lng, display = geocode(name + " " + address[:10])

        if new_lat is None:
            print(f"{name:<30} {f'({old_lat:.4f}, {old_lng:.4f})':<30} {'取得失敗 → スキップ'}")
            failed += 1
            time.sleep(WAIT_SEC)
            continue

        status = "✓ 更新" if not dry_run else "（dry-run）"
        print(f"{name:<30} {f'({old_lat:.4f}, {old_lng:.4f})':<30} {f'({new_lat:.4f}, {new_lng:.4f})':<30} {status}")
        print(f"  → {display}")

        if not dry_run:
            supabase.table("stores").update({
                "lat": new_lat,
                "lng": new_lng,
            }).eq("id", store["id"]).execute()

        updated += 1
        time.sleep(WAIT_SEC)  # 利用規約準拠

    print("\n" + "=" * 60)
    if dry_run:
        print(f"DRY RUN 完了: {updated} 件更新予定 / {failed} 件失敗")
        print("実際に更新するには --dry-run を外して再実行してください")
    else:
        print(f"完了: {updated} 件更新 / {failed} 件失敗")
        if updated > 0:
            print("\n地図で位置を確認してください:")
            print("  GitHub Pages の URL を開いて各店舗マーカーをチェック")
    print("=" * 60)


def geocode(query: str) -> tuple[float | None, float | None, str]:
    """
    Nominatim で住所・店舗名を検索して (lat, lng, 表示名) を返す。
    失敗時は (None, None, "") を返す。
    """
    params = {
        "q":                query,
        "format":           "json",
        "limit":            "1",
        "countrycodes":     "jp",
        "accept-language":  "ja",
    }
    headers = {
        "User-Agent": "PriceCompareMap/1.0 (price-compare-gyotoku)"
    }

    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(NOMINATIM_URL, params=params, headers=headers)
            r.raise_for_status()
            data = r.json()

        if not data:
            return None, None, ""

        result = data[0]
        return float(result["lat"]), float(result["lon"]), result["display_name"]

    except Exception as e:
        print(f"  Nominatim エラー: {e}")
        return None, None, ""


if __name__ == "__main__":
    main()
