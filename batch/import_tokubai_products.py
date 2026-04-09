"""
import_tokubai_products.py  ─  トクバイのカテゴリページから商品名を取得して
                                product_groups / product_aliases に登録する

HTML構造（確認済み）:
  商品名は table > tr > td > a[href^="/product_categories/"] に格納されている

対象: https://tokubai.co.jp/product_categories/3 〜 18

使い方:
  python import_tokubai_products.py            # 全件登録
  python import_tokubai_products.py --dry-run  # 確認のみ
"""

import argparse, os, re, time, unicodedata
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from supabase import create_client

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

TOKUBAI_BASE = "https://tokubai.co.jp"
CATEGORY_IDS = list(range(3, 19))  # 3〜18
SLEEP_SEC    = 1.2
HEADERS = {
    "User-Agent":      "PriceBot/1.0 (+mailto:your@email.com)",
    "Accept-Language": "ja,en;q=0.9",
}

# カテゴリID → (category, subcategory) マッピング
CATEGORY_INFO = {
    3:  ("食品", "野菜"),
    4:  ("食品", "果物"),
    5:  ("食品", "肉・加工肉"),
    6:  ("食品", "魚・海産物"),
    7:  ("食品", "乳製品・卵"),
    8:  ("食品", "豆腐・大豆製品"),
    9:  ("食品", "惣菜・弁当"),
    10: ("食品", "米・パン・麺"),
    11: ("食品", "調味料・油"),
    12: ("食品", "冷凍食品"),
    13: ("食品", "菓子・スイーツ"),
    14: ("食品", "レトルト・缶詰"),
    15: ("飲料", "飲料"),
    16: ("飲料", "アルコール"),
    17: ("日用品", "日用品"),
    18: ("日用品", "ペット用品"),
}

NG_WORDS = [
    "お店", "ログイン", "新規登録", "設定", "配信", "さがす", "一覧",
    "トクバイ", "くふう", "Zaim", "家計簿", "郵便番号", "特売情報",
    "チラシ", "クーポン", "ランキング", "もっと見る", "すべて",
]

# ──────────────────────────────────────────────────────
# テキスト正規化・エイリアス生成
# ──────────────────────────────────────────────────────
def normalize(text):
    return re.sub(r"[\s　\-ー_・]+", "",
                  unicodedata.normalize("NFKC", str(text or ""))).strip().lower()

def kata2hira(t):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ン" else c for c in t)

def hira2kata(t):
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ん" else c for c in t)

def generate_aliases(name):
    a = {name, kata2hira(name), hira2kata(name)}
    # 中点・スペース除去
    np = re.sub(r"[・\s　]", "", name)
    if np != name:
        a.update([np, kata2hira(np), hira2kata(np)])
    # 語尾「類」「等」除去
    for sfx in ["類", "等", "など"]:
        if name.endswith(sfx):
            b = name[:-len(sfx)].strip()
            if len(b) >= 2:
                a.update([b, kata2hira(b), hira2kata(b)])
    # 「〜肉」→「〜にく」
    if name.endswith("肉") and len(name) > 1:
        a.add(name[:-1] + "にく")
    return [x for x in sorted(a) if x]


# ──────────────────────────────────────────────────────
# スクレイピング
# ──────────────────────────────────────────────────────
def fetch_products(client, cat_id):
    """table > tr > td > a[href^="/product_categories/"] から商品名を取得"""
    url = f"{TOKUBAI_BASE}/product_categories/{cat_id}"
    try:
        r = client.get(url, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"  取得失敗: {e}")
        return "", []

    soup = BeautifulSoup(r.text, "lxml")

    # カテゴリ名をtitleから取得（例: 「野菜の値段...」→「野菜」）
    cat_name = ""
    title = soup.find("title")
    if title:
        m = re.match(r"^([^\sのｰ|｜]+)", title.text.strip())
        cat_name = m.group(1) if m else ""

    # 商品名を抽出
    products = []
    seen = set()
    for a in soup.select("table td a[href^='/product_categories/']"):
        href = a.get("href", "")
        # 親カテゴリ（3〜18）へのリンクはスキップ
        m = re.search(r"/product_categories/(\d+)$", href)
        if m and int(m.group(1)) in CATEGORY_IDS:
            continue

        name = a.get_text(strip=True)
        if not name or not (2 <= len(name) <= 25):
            continue
        if any(ng in name for ng in NG_WORDS):
            continue
        if name not in seen:
            seen.add(name)
            products.append(name)

    print(f"  [category/{cat_id}] {cat_name} → {len(products)} 件")
    return cat_name, products


# ──────────────────────────────────────────────────────
# Supabase 書き込み
# ──────────────────────────────────────────────────────
def load_existing(supabase):
    pg = supabase.table("product_groups").select("id, canonical_name").execute()
    pa = supabase.table("product_aliases").select("alias, group_id").execute()
    groups  = {r["canonical_name"]: r["id"] for r in (pg.data or [])}
    aliases = {r["alias"]: r["group_id"] for r in (pa.data or [])}
    return groups, aliases


def register_product(supabase, name, cat_id, groups, aliases, dry_run):
    cat, subcat = CATEGORY_INFO.get(cat_id, ("食品", "その他"))

    # product_groups
    if name not in groups:
        if not dry_run:
            res = supabase.table("product_groups").insert({
                "canonical_name": name,
                "category":       cat,
                "subcategory":    subcat,
            }).execute()
            gid = res.data[0]["id"] if res.data else None
        else:
            gid = f"dry:{name}"
        if gid:
            groups[name] = gid
            print(f"    + group: {name}")

    gid = groups.get(name)
    if not gid:
        return 0

    # product_aliases（未登録のみ）
    new_al = [a for a in generate_aliases(name) if a not in aliases]
    if new_al:
        rows = [{"group_id": gid, "alias": a, "source": "tokubai_category"}
                for a in new_al]
        if not dry_run:
            for i in range(0, len(rows), 50):
                supabase.table("product_aliases").insert(rows[i:i+50]).execute()
        for a in new_al:
            aliases[a] = gid
        print(f"    + aliases({len(new_al)}): {new_al[:4]}"
              f"{'...' if len(new_al) > 4 else ''}")
    return len(new_al)


# ──────────────────────────────────────────────────────
# メイン
# ──────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定")
        return

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK")
    if args.dry_run:
        print("=== DRY RUN（DBへの書き込みなし）===\n")

    groups, aliases = load_existing(supabase)
    print(f"  既存 groups: {len(groups)}件 / aliases: {len(aliases)}件\n")

    new_g = new_a = 0
    with httpx.Client(headers=HEADERS, follow_redirects=True) as client:
        for cat_id in CATEGORY_IDS:
            print(f"\n--- category/{cat_id} ---")
            _, products = fetch_products(client, cat_id)
            time.sleep(SLEEP_SEC)
            bg = len(groups)
            for name in products:
                new_a += register_product(supabase, name, cat_id,
                                          groups, aliases, args.dry_run)
            new_g += len(groups) - bg

    if not args.dry_run:
        print("\nビュー更新中...")
        try:
            supabase.rpc("refresh_price_view", {}).execute()
            print("✓ 完了")
        except Exception as e:
            print(f"  失敗: {e}")

    print(f"""
========================================
完了
  新規 product_groups:  {new_g} 件
  新規 product_aliases: {new_a} 件
  合計 product_groups:  {len(groups)} 件
  合計 product_aliases: {len(aliases)} 件
========================================""")

if __name__ == "__main__":
    main()
