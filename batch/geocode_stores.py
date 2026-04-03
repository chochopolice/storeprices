 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/batch/geocode_stores.py b/batch/geocode_stores.py
index 0d10e2e197e82cdffd85ed27c9cb439acee9a3c6..7db8553b4e159fc71a69a525ce89fd1fda691e9e 100644
--- a/batch/geocode_stores.py
+++ b/batch/geocode_stores.py
@@ -1,144 +1,324 @@
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
 
-import asyncio
+import math
 import os
+import re
 import sys
 import time
+from dataclasses import dataclass
 from pathlib import Path
 
 import httpx
 from dotenv import load_dotenv
 from supabase import create_client
 
 # ── 設定 ──────────────────────────────────────────────────────────────
 BASE_DIR = Path(__file__).parent
 NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
 WAIT_SEC = 1.1   # Nominatim の利用規約: 1秒に1リクエスト
+MAX_ACCEPTABLE_MOVE_KM = 25.0  # 既存座標がある場合、急な飛び先は原則 reject
+
+
+@dataclass
+class GeocodeResult:
+    lat: float
+    lng: float
+    display_name: str
+    importance: float
 
 
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
-    print("-" * 110)
+    print("-" * 120)
 
     updated = 0
     failed = 0
 
     for store in stores:
-        name    = store["name"]
-        address = store.get("address", "")
-        old_lat = store.get("lat")
-        old_lng = store.get("lng")
+        name = (store.get("name") or "").strip()
+        address = normalize_address(store.get("address", ""))
+        old_lat = to_float_or_none(store.get("lat"))
+        old_lng = to_float_or_none(store.get("lng"))
 
         if not address:
             print(f"{name:<30} {'住所なし → スキップ'}")
             failed += 1
             continue
 
-        # Nominatim でジオコーディング
-        new_lat, new_lng, display = geocode(address)
+        # 複数戦略でジオコーディング
+        best = geocode_with_fallback(name=name, address=address, old_lat=old_lat, old_lng=old_lng)
 
-        if new_lat is None:
-            # 住所で失敗したら店舗名でリトライ
-            print(f"  住所で失敗、店舗名でリトライ: {name}")
-            new_lat, new_lng, display = geocode(name + " " + address[:10])
-
-        if new_lat is None:
-            print(f"{name:<30} {f'({old_lat:.4f}, {old_lng:.4f})':<30} {'取得失敗 → スキップ'}")
+        if best is None:
+            old_coord = format_coord(old_lat, old_lng)
+            print(f"{name:<30} {old_coord:<30} {'取得失敗 → スキップ'}")
             failed += 1
             time.sleep(WAIT_SEC)
             continue
 
         status = "✓ 更新" if not dry_run else "（dry-run）"
-        print(f"{name:<30} {f'({old_lat:.4f}, {old_lng:.4f})':<30} {f'({new_lat:.4f}, {new_lng:.4f})':<30} {status}")
-        print(f"  → {display}")
+        old_coord = format_coord(old_lat, old_lng)
+        new_coord = f"({best.lat:.4f}, {best.lng:.4f})"
+
+        print(f"{name:<30} {old_coord:<30} {new_coord:<30} {status}")
+        print(f"  → {best.display_name}")
 
         if not dry_run:
             supabase.table("stores").update({
-                "lat": new_lat,
-                "lng": new_lng,
+                "lat": best.lat,
+                "lng": best.lng,
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
 
 
-def geocode(query: str) -> tuple[float | None, float | None, str]:
-    """
-    Nominatim で住所・店舗名を検索して (lat, lng, 表示名) を返す。
-    失敗時は (None, None, "") を返す。
-    """
+def normalize_address(address: str) -> str:
+    """機械検索向けに住所の揺れを軽く正規化する。"""
+    addr = (address or "").strip()
+    addr = re.sub(r"\s+", " ", addr)
+    addr = addr.replace("−", "-").replace("ー", "-")
+    addr = addr.replace("丁目", "-")
+    addr = addr.replace("番地", "-")
+    addr = addr.replace("番", "-")
+    addr = re.sub(r"-+", "-", addr)
+    return addr.strip("-")
+
+
+def to_float_or_none(v: object) -> float | None:
+    try:
+        if v is None:
+            return None
+        return float(v)
+    except (TypeError, ValueError):
+        return None
+
+
+def format_coord(lat: float | None, lng: float | None) -> str:
+    if lat is None or lng is None:
+        return "(なし)"
+    return f"({lat:.4f}, {lng:.4f})"
+
+
+def geocode_with_fallback(name: str, address: str, old_lat: float | None, old_lng: float | None) -> GeocodeResult | None:
+    """誤爆を避けつつ複数クエリで候補を探し、最も妥当な1件を返す。"""
+    area_hint = extract_area_hint(address)
+    base_queries = [
+        f"{address}",
+        f"{name} {address}",
+        f"{name} {area_hint}" if area_hint else name,
+    ]
+
+    # 重複除去
+    queries: list[str] = []
+    for q in base_queries:
+        q = q.strip()
+        if q and q not in queries:
+            queries.append(q)
+
+    for idx, query in enumerate(queries):
+        if idx > 0:
+            print(f"  リトライ({idx + 1}/{len(queries)}): {query}")
+
+        candidate = geocode_single(query=query, old_lat=old_lat, old_lng=old_lng)
+        if candidate is None:
+            continue
+
+        if is_unreasonable_jump(candidate.lat, candidate.lng, old_lat, old_lng):
+            dist = haversine_km(old_lat, old_lng, candidate.lat, candidate.lng)
+            print(f"  候補を破棄: 既存座標から {dist:.1f}km 離れているため誤爆の可能性")
+            continue
+
+        if not seems_japan(candidate.display_name):
+            print("  候補を破棄: 日本住所として判定できず")
+            continue
+
+        return candidate
+
+    return None
+
+
+def geocode_single(query: str, old_lat: float | None, old_lng: float | None) -> GeocodeResult | None:
+    """Nominatim で1クエリ検索して最良候補を返す。"""
     params = {
-        "q":                query,
-        "format":           "json",
-        "limit":            "1",
-        "countrycodes":     "jp",
-        "accept-language":  "ja",
+        "q": query,
+        "format": "jsonv2",
+        "limit": "5",
+        "countrycodes": "jp",
+        "accept-language": "ja",
+        "addressdetails": "1",
     }
+
+    # 既存座標がある場合は近傍を優先して誤爆を防ぐ
+    if old_lat is not None and old_lng is not None:
+        viewbox = make_viewbox(old_lat, old_lng, box_km=12)
+        if viewbox:
+            params["viewbox"] = viewbox
+            params["bounded"] = "1"
+
     headers = {
-        "User-Agent": "PriceCompareMap/1.0 (price-compare-gyotoku)"
+        "User-Agent": "PriceCompareMap/1.1 (price-compare-gyotoku)"
     }
 
     try:
         with httpx.Client(timeout=10) as client:
             r = client.get(NOMINATIM_URL, params=params, headers=headers)
             r.raise_for_status()
             data = r.json()
 
         if not data:
-            return None, None, ""
+            return None
+
+        best_item = choose_best_candidate(data, old_lat, old_lng)
+        if best_item is None:
+            return None
 
-        result = data[0]
-        return float(result["lat"]), float(result["lon"]), result["display_name"]
+        return GeocodeResult(
+            lat=float(best_item["lat"]),
+            lng=float(best_item["lon"]),
+            display_name=best_item.get("display_name", ""),
+            importance=float(best_item.get("importance", 0.0) or 0.0),
+        )
 
     except Exception as e:
         print(f"  Nominatim エラー: {e}")
-        return None, None, ""
+        return None
+
+
+def choose_best_candidate(candidates: list[dict], old_lat: float | None, old_lng: float | None) -> dict | None:
+    """候補にスコアをつけて最も妥当な結果を選ぶ。"""
+    scored: list[tuple[float, dict]] = []
+
+    for c in candidates:
+        try:
+            lat = float(c["lat"])
+            lng = float(c["lon"])
+        except (TypeError, ValueError, KeyError):
+            continue
+
+        score = float(c.get("importance", 0.0) or 0.0)
+        display_name = c.get("display_name", "")
+
+        if seems_japan(display_name):
+            score += 0.5
+
+        if old_lat is not None and old_lng is not None:
+            dist = haversine_km(old_lat, old_lng, lat, lng)
+            # 近いほど加点（0kmで+1.0、20km以上で+0）
+            score += max(0.0, 1.0 - min(dist, 20.0) / 20.0)
+
+        scored.append((score, c))
+
+    if not scored:
+        return None
+
+    scored.sort(key=lambda x: x[0], reverse=True)
+    return scored[0][1]
+
+
+def extract_area_hint(address: str) -> str:
+    """住所から市区町村レベルのヒントを抜き出す。"""
+    patterns = [
+        r"(東京都[^\s,、]*)",
+        r"(北海道[^\s,、]*)",
+        r"((?:京都府|大阪府)[^\s,、]*)",
+        r"((?:.{2,3}県)[^\s,、]*)",
+    ]
+    for p in patterns:
+        m = re.search(p, address)
+        if m:
+            return m.group(1)
+
+    # 末尾側に市区情報があるケース
+    m = re.search(r"([^\s,、]*(?:市|区|町|村))", address)
+    return m.group(1) if m else ""
+
+
+def seems_japan(display_name: str) -> bool:
+    return "日本" in display_name or "Japan" in display_name
+
+
+def is_unreasonable_jump(new_lat: float, new_lng: float, old_lat: float | None, old_lng: float | None) -> bool:
+    if old_lat is None or old_lng is None:
+        return False
+    return haversine_km(old_lat, old_lng, new_lat, new_lng) > MAX_ACCEPTABLE_MOVE_KM
+
+
+def make_viewbox(lat: float, lng: float, box_km: float = 10.0) -> str | None:
+    """Nominatim 用 viewbox (left,top,right,bottom) を返す。"""
+    if box_km <= 0:
+        return None
+
+    dlat = box_km / 111.0
+    cos_lat = math.cos(math.radians(lat))
+    if abs(cos_lat) < 1e-6:
+        return None
+    dlng = box_km / (111.0 * cos_lat)
+
+    left = lng - dlng
+    right = lng + dlng
+    top = lat + dlat
+    bottom = lat - dlat
+    return f"{left:.6f},{top:.6f},{right:.6f},{bottom:.6f}"
+
+
+def haversine_km(lat1: float | None, lng1: float | None, lat2: float, lng2: float) -> float:
+    if lat1 is None or lng1 is None:
+        return 0.0
+
+    r = 6371.0
+    p1 = math.radians(lat1)
+    p2 = math.radians(lat2)
+    dp = math.radians(lat2 - lat1)
+    dl = math.radians(lng2 - lng1)
+
+    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
+    return 2 * r * math.asin(math.sqrt(a))
 
 
 if __name__ == "__main__":
     main()
 
EOF
)
