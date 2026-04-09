"""
import_stores_json.py  ─  stores.json の商品データを Supabase に一括インポート

やること:
  1. stores.json の各店舗を stores テーブルに照合（store_code または name で）
  2. 各商品を product_aliases で name → group_id に名寄せ
  3. normalized_prices に insert
  4. マテリアライズドビューを更新

使い方:
  batch/ フォルダで実行:
    python import_stores_json.py
"""

import json, os, sys, unicodedata, re
from datetime import date
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

BASE_DIR    = Path(__file__).parent
STORES_JSON = BASE_DIR.parent / "data" / "stores.json"

load_dotenv(BASE_DIR / ".env")

def normalize(text):
    text = unicodedata.normalize("NFKC", str(text or ""))
    return re.sub(r"[\s　\-ー_]+", "", text).strip().lower()

def find_group_id(item_name, alias_map):
    n = normalize(item_name)
    if n in alias_map:
        return alias_map[n]
    for alias, gid in alias_map.items():
        if alias and alias in n:
            return gid
    for alias, gid in alias_map.items():
        if alias and n in alias:
            return gid
    return None

def main():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  .env に SUPABASE_URL と SUPABASE_SERVICE_KEY を設定してください")
        sys.exit(1)

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK")

    # stores.json 読み込み
    stores_data = json.loads(STORES_JSON.read_text(encoding="utf-8"))
    print(f"  stores.json: {len(stores_data)} 店舗")

    # ── Supabase の stores テーブルを全件取得（name で照合）
    res = supabase.table("stores").select("id, name, address, lat, lng").execute()
    db_stores = res.data or []
    db_store_map = {normalize(s["name"]): s for s in db_stores}
    print(f"  DBの店舗数: {len(db_stores)}")

    # ── product_aliases を取得
    res2 = supabase.table("product_aliases").select("alias, group_id").execute()
    alias_map = {normalize(r["alias"]): r["group_id"] for r in (res2.data or [])}
    print(f"  エイリアス数: {len(alias_map)}")

    today = date.today().isoformat()
    inserted_stores = 0
    inserted_prices = 0
    skipped_prices  = 0
    unmatched_items = []

    for store in stores_data:
        store_name = store["name"]
        lat  = store.get("lat")
        lng  = store.get("lng")

        # DBで店舗を照合
        db_store = db_store_map.get(normalize(store_name))

        # DBに存在しない or 座標がない場合は insert/update
        if not db_store:
            if not lat or not lng:
                print(f"  SKIP（座標なし・DB未登録）: {store_name}")
                continue
            res_ins = supabase.table("stores").insert({
                "name":    store_name,
                "type":    store.get("type", "スーパー"),
                "lat":     lat,
                "lng":     lng,
                "address": store.get("address", ""),
            }).execute()
            db_store = res_ins.data[0] if res_ins.data else None
            if db_store:
                db_store_map[normalize(store_name)] = db_store
                inserted_stores += 1
                print(f"  INSERT store: {store_name}")
            else:
                print(f"  ERROR store: {store_name}")
                continue
        else:
            # 座標が未設定の場合は更新
            if lat and lng and (not db_store.get("lat") or not db_store.get("lng")):
                supabase.table("stores").update({"lat": lat, "lng": lng}).eq("id", db_store["id"]).execute()
                print(f"  UPDATE 座標: {store_name}")

        store_uuid = db_store["id"]

        # 商品データを normalized_prices に insert
        rows = []
        for item in store.get("items", []):
            item_name = item.get("name", "")
            price     = item.get("price")
            last_seen = str(item.get("last_seen", ""))

            if not item_name or not price:
                continue

            group_id = find_group_id(item_name, alias_map)
            if not group_id:
                unmatched_items.append(item_name)
                skipped_prices += 1
                continue

            # valid_from を last_seen から変換
            if len(last_seen) == 8:
                valid_from = f"{last_seen[:4]}-{last_seen[4:6]}-{last_seen[6:8]}"
            else:
                valid_from = today

            rows.append({
                "store_id":         store_uuid,
                "product_group_id": group_id,
                "price":            int(price),
                "valid_from":       valid_from,
                "is_sale":          False,
            })

        if rows:
            # 100件ずつ insert
            for i in range(0, len(rows), 100):
                supabase.table("normalized_prices").insert(rows[i:i+100]).execute()
            inserted_prices += len(rows)
            print(f"  {store_name}: {len(rows)}件 insert")

    # ビュー更新
    print("\nマテリアライズドビュー更新中...")
    supabase.rpc("refresh_price_view", {}).execute()
    print("✓ 更新完了")

    print(f"""
========================================
完了
  店舗 INSERT:    {inserted_stores} 件
  価格 INSERT:    {inserted_prices} 件
  名寄せ不可:     {skipped_prices} 件
========================================""")

    if unmatched_items:
        unique_unmatched = list(dict.fromkeys(unmatched_items))[:20]
        print(f"\n名寄せできなかった商品名（上位20件）:")
        for name in unique_unmatched:
            print(f"  「{name}」")
        print("\n→ product_aliases に追加すると次回から検索できます")

if __name__ == "__main__":
    main()
