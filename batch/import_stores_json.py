"""
import_stores_json.py  ─  stores.json の商品データを Supabase に一括インポート

修正点:
  - 座標なし店舗もDBに名前照合で登録
  - subcategoryをDBのproduct_groupsのsubcategoryに変換してマッチ精度向上
  - 商品名の部分一致マッチも強化
"""

import json, os, sys, unicodedata, re
from datetime import date
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

BASE_DIR    = Path(__file__).parent
STORES_JSON = BASE_DIR.parent / "data" / "stores.json"

load_dotenv(BASE_DIR / ".env")

# stores.json の subcategory → DB の subcategory マッピング
SUBCAT_MAP = {
    "野菜":   "野菜",
    "魚":     "魚・海産物",
    "調味料":  "調味料",
    "海産物":  "魚・海産物",
    "納豆":   "大豆製品",
    "鶏肉":   "肉・加工肉",
    "果物":   "果物",
    "豚肉":   "肉・加工肉",
    "牛肉":   "肉・加工肉",
    "豆腐":   "大豆製品",
    "豆乳":   "豆腐・大豆製品",
    "乳製品":  "乳製品・卵",
    "卵":     "卵",
    "漬物":   "惣菜・弁当",
    "菓子":   "菓子・スイーツ",
    "おつまみ": "菓子・スイーツ",
    "加工品":  "惣菜・弁当",
    "加工肉":  "肉・加工肉",
    "ごはん":  "米・パン・麺",
    "惣菜":   "惣菜・弁当",
    "香辛料":  "調味料",
    "油":     "調味料",
    "パン":   "米・パン・麺",
    "米":     "米・パン・麺",
    "水":     "飲料",
    "コーヒー": "飲料",
    "お茶":   "飲料",
    "シャンプー": "日用品",
    "歯ブラシ": "日用品",
    "歯磨き粉": "日用品",
    "洗剤":   "日用品",
    "掃除":   "日用品",
    "トイレ":  "日用品",
    "衛生用品": "日用品",
    "ゴミ袋":  "日用品",
    "消臭剤":  "日用品",
    "化粧水":  "日用品",
    "整髪料":  "日用品",
    "洗濯洗剤": "洗剤",
    "バス用品": "日用品",
    "ボディーソープ": "日用品",
    "キッチンペーパー": "台所用品",
    "スポンジ": "台所用品",
}

def normalize(t):
    t = unicodedata.normalize("NFKC", str(t or ""))
    return re.sub(r"[\s　\-ー_・]+", "", t).strip().lower()

def find_group_id(item_name, subcat, alias_map, group_subcat_map):
    n = normalize(item_name)

    # 1. 完全一致
    if n in alias_map:
        return alias_map[n]

    # 2. aliasが商品名に含まれる（例: "納豆" → "おかめ納豆"）
    matches = []
    for alias, gid in alias_map.items():
        if alias and len(alias) >= 2 and alias in n:
            matches.append((len(alias), gid))
    if matches:
        matches.sort(reverse=True)
        return matches[0][1]

    # 3. 商品名がaliasに含まれる
    for alias, gid in alias_map.items():
        if alias and len(alias) >= 2 and n in alias:
            return gid

    return None

def main():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定")
        sys.exit(1)

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK")

    stores_data = json.loads(STORES_JSON.read_text(encoding="utf-8"))
    print(f"  stores.json: {len(stores_data)} 店舗 / "
          f"{sum(len(s.get('items',[])) for s in stores_data)} 商品")

    # DBの店舗一覧取得（名前で照合）
    res = supabase.table("stores").select("id, name, lat, lng").execute()
    db_stores = {normalize(s["name"]): s for s in (res.data or [])}
    print(f"  DBの店舗数: {len(db_stores)}")

    # product_aliases 取得
    res2 = supabase.table("product_aliases").select("alias, group_id").execute()
    alias_map = {normalize(r["alias"]): r["group_id"] for r in (res2.data or [])}
    print(f"  エイリアス数: {len(alias_map)}")

    # product_groups の subcategory マップ
    res3 = supabase.table("product_groups").select("id, canonical_name, subcategory").execute()
    group_subcat_map = {r["id"]: r["subcategory"] for r in (res3.data or [])}

    today = date.today().isoformat()
    inserted_stores = 0
    inserted_prices = 0
    skipped_prices  = 0
    unmatched = []

    for store in stores_data:
        store_name = store["name"]
        lat = store.get("lat")
        lng = store.get("lng")

        # DB照合（正規化した名前で）
        db_store = db_stores.get(normalize(store_name))

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
                db_stores[normalize(store_name)] = db_store
                inserted_stores += 1
                print(f"  INSERT store: {store_name}")
        else:
            # 座標が未設定の場合は更新
            if lat and lng and (not db_store.get("lat") or not db_store.get("lng")):
                supabase.table("stores").update(
                    {"lat": lat, "lng": lng}
                ).eq("id", db_store["id"]).execute()
                print(f"  UPDATE 座標: {store_name}")

        if not db_store:
            continue
        store_uuid = db_store["id"]

        # 商品を normalized_prices に insert
        rows = []
        for item in store.get("items", []):
            item_name = item.get("name", "")
            price     = item.get("price")
            subcat    = item.get("subcategory", "")
            last_seen = str(item.get("last_seen", ""))

            if not item_name or not price:
                continue

            group_id = find_group_id(item_name, subcat, alias_map, group_subcat_map)
            if not group_id:
                unmatched.append(f"{store_name}: {item_name}")
                skipped_prices += 1
                continue

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
            for i in range(0, len(rows), 100):
                supabase.table("normalized_prices").insert(rows[i:i+100]).execute()
            inserted_prices += len(rows)
            print(f"  {store_name}: {len(rows)}件 insert（{skipped_prices}件スキップ）")

    # ビュー更新
    print("\nビュー更新中...")
    supabase.rpc("refresh_price_view", {}).execute()
    print("✓ 更新完了")

    print(f"""
========================================
完了
  店舗 INSERT:  {inserted_stores} 件
  価格 INSERT:  {inserted_prices} 件
  名寄せ不可:   {skipped_prices} 件
========================================""")

    if unmatched:
        print(f"\n名寄せできなかった商品（上位30件）:")
        for name in list(dict.fromkeys(unmatched))[:30]:
            print(f"  {name}")

if __name__ == "__main__":
    main()
