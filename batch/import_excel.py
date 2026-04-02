"""
import_excel.py  ─  Excel データを Supabase に一括インポート

【使い方】
  1. このファイルを batch/ フォルダに置く
  2. Excel ファイルを batch/ フォルダに置く
  3. batch/.env に SUPABASE_URL と SUPABASE_SERVICE_KEY が設定されていることを確認
  4. batch/ フォルダで実行:
       python import_excel.py

【やること】
  1. stores.json の店舗情報を Supabase の stores テーブルに登録
  2. Excel の価格データを normalized_prices テーブルに登録
  3. マテリアライズドビューを更新してフロントに反映
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

# ── 設定 ──────────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
STORES_JSON = BASE_DIR / "data" / "stores.json"      # stores.json の場所
EXCEL_FILE  = BASE_DIR / "最安商品リスト_20260329.xlsx"  # Excel の場所

# Excel 内の店舗名 → stores.json の店舗名 対応表
# （表記が微妙に違う場合はここで吸収する）
STORE_NAME_MAP = {
    "Selection FOODS MARKET":  "Selection FOODS MARKET",
    "マルエツ行徳駅前店":          "マルエツ 行徳駅前店",
    "西友行徳店":                "西友 行徳店",
    "ピカソ南行徳駅前店":          "ピカソ 南行徳駅前店",
    "くすりの福太郎行徳駅前店":     "くすりの福太郎 行徳駅前店",
    "ジェーソン欠真間店":          "ジェーソン 欠真間店",
}

# ── メイン処理 ────────────────────────────────────────────────────────
def main():
    # .env 読み込み
    load_dotenv(BASE_DIR / ".env")
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  .env に SUPABASE_URL と SUPABASE_SERVICE_KEY を設定してください")
        sys.exit(1)

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK")

    # ── Step 1: stores.json → stores テーブル ─────────────────────────
    print("\n[Step 1] 店舗データを登録...")
    stores_json = json.loads(STORES_JSON.read_text(encoding="utf-8"))
    store_name_to_uuid = _upsert_stores(supabase, stores_json)
    print(f"  {len(store_name_to_uuid)} 店舗を登録/確認しました")

    # ── Step 2: product_aliases → name→group_id マップ構築 ────────────
    print("\n[Step 2] 商品エイリアスを読み込み...")
    alias_map = _build_alias_map(supabase)
    print(f"  {len(alias_map)} 件のエイリアスを取得しました")

    # ── Step 3: Excel → normalized_prices ─────────────────────────────
    print("\n[Step 3] Excel データを読み込み...")
    if not EXCEL_FILE.exists():
        print(f"❌  Excel ファイルが見つかりません: {EXCEL_FILE}")
        print(f"   batch/ フォルダに「{EXCEL_FILE.name}」を置いてください")
        sys.exit(1)

    df = pd.read_excel(EXCEL_FILE)
    df.columns = ["date", "store_name_raw", "item_name", "price", "category", "subcategory"]
    df["date"]  = df["date"].astype(str)
    df["price"] = pd.to_numeric(df["price"], errors="coerce").fillna(0).astype(int)

    # 行徳エリアの店舗のみ・最新価格のみ
    df = df[df["store_name_raw"].isin(STORE_NAME_MAP.keys())].copy()
    df = df.sort_values("date", ascending=False)
    df = df.drop_duplicates(subset=["store_name_raw", "item_name"], keep="first")
    print(f"  対象: {len(df)} 件（重複除去後の最新価格）")

    inserted, skipped = _upsert_prices(supabase, df, store_name_to_uuid, alias_map)
    print(f"  登録成功: {inserted} 件 / 名寄せできず スキップ: {skipped} 件")

    # スキップされた商品名を表示（alias 追加の参考に）
    if skipped > 0:
        _show_unmatched(df, alias_map, store_name_to_uuid)

    # ── Step 4: stores.json の全商品も登録（サンプルデータ分）─────────
    print("\n[Step 4] stores.json のサンプル価格データも登録...")
    sample_inserted = _upsert_from_stores_json(
        supabase, stores_json, store_name_to_uuid, alias_map
    )
    print(f"  登録成功: {sample_inserted} 件")

    # ── Step 5: ビュー更新 ─────────────────────────────────────────────
    print("\n[Step 5] マテリアライズドビューを更新...")
    supabase.rpc("refresh_price_view", {}).execute()
    print("  ✓ 更新完了")

    print("\n" + "=" * 50)
    print("インポート完了！")
    print("config.js の DATA_SOURCE を 'supabase' に変更してください")
    print("=" * 50)


# ── ヘルパー関数 ──────────────────────────────────────────────────────

def _upsert_stores(supabase, stores_json: list) -> dict[str, str]:
    """stores テーブルに登録し、店舗名→UUID のマップを返す"""
    name_to_uuid = {}

    # 既存レコードを取得
    existing = supabase.table("stores").select("id, name").execute()
    for row in (existing.data or []):
        name_to_uuid[row["name"]] = row["id"]

    # 未登録のものだけ insert
    for s in stores_json:
        if s["name"] in name_to_uuid:
            print(f"  スキップ（既存）: {s['name']}")
            continue

        res = supabase.table("stores").insert({
            "name":    s["name"],
            "type":    s.get("type", ""),
            "lat":     s["lat"],
            "lng":     s["lng"],
            "address": s.get("address", ""),
        }).execute()

        if res.data:
            name_to_uuid[s["name"]] = res.data[0]["id"]
            print(f"  登録: {s['name']}")

    return name_to_uuid


def _build_alias_map(supabase) -> dict[str, str]:
    """
    product_aliases テーブルから
    normalize(alias) → group_id のマップを作る
    """
    import unicodedata, re

    res = supabase.table("product_aliases").select("alias, group_id").execute()

    def normalize(text):
        text = unicodedata.normalize("NFKC", str(text or ""))
        return re.sub(r"[\s　\-ー_]+", "", text).strip().lower()

    return {normalize(row["alias"]): row["group_id"] for row in (res.data or [])}


def _find_group_id(item_name: str, alias_map: dict) -> str | None:
    """商品名から group_id を探す（完全一致 → 部分一致）"""
    import unicodedata, re

    def normalize(text):
        text = unicodedata.normalize("NFKC", str(text or ""))
        return re.sub(r"[\s　\-ー_]+", "", text).strip().lower()

    n = normalize(item_name)

    # 完全一致
    if n in alias_map:
        return alias_map[n]

    # alias が商品名に含まれる（例: "豆腐" → "絹豆腐" にヒット）
    for alias, gid in alias_map.items():
        if alias and alias in n:
            return gid

    # 商品名が alias に含まれる
    for alias, gid in alias_map.items():
        if alias and n in alias:
            return gid

    return None


def _upsert_prices(supabase, df, store_name_to_uuid, alias_map) -> tuple[int, int]:
    """Excel データを normalized_prices に upsert する"""
    rows = []
    skipped = 0

    for _, row in df.iterrows():
        # 店舗UUID を解決
        json_name = STORE_NAME_MAP.get(row["store_name_raw"])
        store_uuid = store_name_to_uuid.get(json_name) if json_name else None
        if not store_uuid:
            skipped += 1
            continue

        # product_group_id を解決
        group_id = _find_group_id(row["item_name"], alias_map)
        if not group_id:
            skipped += 1
            continue

        rows.append({
            "store_id":         store_uuid,
            "product_group_id": group_id,
            "price":            int(row["price"]),
            "valid_from":       row["date"][:4] + "-" + row["date"][4:6] + "-" + row["date"][6:8],
            "is_sale":          False,
        })

    if not rows:
        return 0, skipped

    # 100件ずつ upsert（Supabase の上限対策）
    inserted = 0
    for i in range(0, len(rows), 100):
        chunk = rows[i:i+100]
        supabase.table("normalized_prices").upsert(
            chunk,
            on_conflict="store_id,product_group_id,valid_from"
        ).execute()
        inserted += len(chunk)

    return inserted, skipped


def _upsert_from_stores_json(supabase, stores_json, store_name_to_uuid, alias_map) -> int:
    """stores.json のサンプル価格データ（イオン・ライフ等）を登録する"""
    today = date.today().isoformat()
    rows = []

    for store in stores_json:
        store_uuid = store_name_to_uuid.get(store["name"])
        if not store_uuid:
            continue

        for item in store.get("items", []):
            group_id = _find_group_id(item["name"], alias_map)
            if not group_id:
                continue

            # last_seen を valid_from に変換
            last_seen = str(item.get("last_seen", ""))
            if len(last_seen) == 8:
                valid_from = f"{last_seen[:4]}-{last_seen[4:6]}-{last_seen[6:8]}"
            else:
                valid_from = today

            rows.append({
                "store_id":         store_uuid,
                "product_group_id": group_id,
                "price":            int(item["price"]),
                "valid_from":       valid_from,
                "is_sale":          False,
            })

    if not rows:
        return 0

    inserted = 0
    for i in range(0, len(rows), 100):
        chunk = rows[i:i+100]
        supabase.table("normalized_prices").upsert(
            chunk,
            on_conflict="store_id,product_group_id,valid_from"
        ).execute()
        inserted += len(chunk)

    return inserted


def _show_unmatched(df, alias_map, store_name_to_uuid):
    """名寄せできなかった商品名を表示する（alias 追加の参考）"""
    print("\n  ── 名寄せできなかった商品名（上位20件） ──")
    print("  schema.sql の product_aliases に追加すると次回から検索できます")

    import unicodedata, re

    def normalize(text):
        text = unicodedata.normalize("NFKC", str(text or ""))
        return re.sub(r"[\s　\-ー_]+", "", text).strip().lower()

    unmatched = set()
    for _, row in df.iterrows():
        json_name = STORE_NAME_MAP.get(row["store_name_raw"])
        store_uuid = store_name_to_uuid.get(json_name) if json_name else None
        if not store_uuid:
            continue
        n = normalize(row["item_name"])
        matched = any(alias in n or n in alias for alias in alias_map)
        if not matched:
            unmatched.add(row["item_name"])

    for name in sorted(unmatched)[:20]:
        print(f"    「{name}」")


if __name__ == "__main__":
    main()
