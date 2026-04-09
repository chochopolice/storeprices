"""
import_tokubai_products.py  ─  トクバイのカテゴリページから商品ワードを取得して
                                product_groups / product_aliases に登録する

対象URL: https://tokubai.co.jp/product_categories/3 〜 18

使い方:
  batch/ フォルダで実行:
    python import_tokubai_products.py            # 全件登録
    python import_tokubai_products.py --dry-run  # 確認のみ
"""

import argparse
import os
import re
import time
import unicodedata
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from supabase import create_client

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

TOKUBAI_BASE = "https://tokubai.co.jp"
CATEGORY_IDS = list(range(3, 19))   # 3〜18
SLEEP_SEC    = 1.2
HEADERS = {
    "User-Agent":      "PriceBot/1.0 (+mailto:your@email.com)",
    "Accept-Language": "ja,en;q=0.9",
}


# ────────────────────────────────────────────────────────────────────
# テキスト正規化
# ────────────────────────────────────────────────────────────────────
def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", str(text or ""))
    return re.sub(r"[\s　\-ー_]+", "", text).strip().lower()


def katakana_to_hiragana(text: str) -> str:
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ン" else c
        for c in text
    )


def hiragana_to_katakana(text: str) -> str:
    return "".join(
        chr(ord(c) + 0x60) if "ぁ" <= c <= "ん" else c
        for c in text
    )


def generate_aliases(name: str) -> list[str]:
    """
    商品名からあいまい検索用のエイリアス一覧を生成する。
    - カタカナ ↔ ひらがな変換
    - 全角 ↔ 半角変換（NFKC済み）
    - 語尾「類」「等」の除去
    - 一般的な表記ゆれ（例: ヨーグルト → ヨーグルト, よーぐると）
    """
    aliases = set()
    aliases.add(name)

    # カタカナ → ひらがな
    hira = katakana_to_hiragana(name)
    if hira != name:
        aliases.add(hira)

    # ひらがな → カタカナ
    kata = hiragana_to_katakana(name)
    if kata != name:
        aliases.add(kata)

    # 末尾の「類」「等」「など」を除去
    for suffix in ["類", "等", "など", "・加工品"]:
        if name.endswith(suffix):
            trimmed = name[:-len(suffix)].strip()
            if trimmed:
                aliases.add(trimmed)
                aliases.add(katakana_to_hiragana(trimmed))
                aliases.add(hiragana_to_katakana(trimmed))

    # 「〜肉」→「〜にく」
    if name.endswith("肉"):
        base = name[:-1]
        aliases.add(base + "にく")
        aliases.add(base + "ニク")

    # スペース・中点を含む場合は除去版も追加
    no_space = re.sub(r"[ 　・]", "", name)
    if no_space != name:
        aliases.add(no_space)

    return sorted(aliases)


# ────────────────────────────────────────────────────────────────────
# スクレイピング
# ────────────────────────────────────────────────────────────────────
def fetch_category_page(client: httpx.Client, cat_id: int) -> dict:
    """
    トクバイのカテゴリページから商品名一覧を取得する。

    戻り値:
      {
        "cat_id":    int,
        "cat_name":  str,   # カテゴリ名（例: 野菜・果物）
        "products":  [str], # 商品名リスト
      }
    """
    url = f"{TOKUBAI_BASE}/product_categories/{cat_id}"
    try:
        r = client.get(url, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"  [category/{cat_id}] 取得失敗: {e}")
        return {"cat_id": cat_id, "cat_name": None, "products": []}

    soup = BeautifulSoup(r.text, "lxml")

    # カテゴリ名: h1 または title から取得
    cat_name = None
    h1 = soup.find("h1")
    if h1:
        cat_name = h1.get_text(strip=True)
        # 「〜の特売・チラシ情報」などの余分な文言を除去
        cat_name = re.sub(r"の(特売|セール|チラシ|クーポン).*$", "", cat_name).strip()
        cat_name = re.sub(r"\s*[\|｜].*$", "", cat_name).strip()

    if not cat_name:
        title = soup.find("title")
        if title:
            cat_name = re.sub(r"[\|｜].*$", "", title.text).strip()
            cat_name = re.sub(r"の(特売|セール|チラシ).*$", "", cat_name).strip()

    # 商品名リスト: アンカータグやリスト要素から取得
    products = set()

    # パターン1: /products?keyword=xxx 形式のリンク
    for a in soup.select("a[href*='products?keyword='], a[href*='keyword=']"):
        text = a.get_text(strip=True)
        if text and 2 <= len(text) <= 30:
            products.add(text)

    # パターン2: .product-name, .category-item 等のクラス
    for sel in [
        "[class*='product'] a", "[class*='category'] a",
        "[class*='item'] a", "li a",
    ]:
        for a in soup.select(sel):
            text = a.get_text(strip=True)
            if text and 2 <= len(text) <= 30 and not text.startswith("http"):
                # 明らかにメニューや関係ない文言を除外
                if not any(ng in text for ng in [
                    "トクバイ", "チラシ", "ログイン", "新規登録", "店舗", "お気に入り",
                    "ランキング", "特売", "セール", "クーポン", "すべて", "もっと",
                ]):
                    products.add(text)

    products = [p for p in sorted(products) if p]
    print(f"  [category/{cat_id}] {cat_name} → {len(products)}商品")
    return {"cat_id": cat_id, "cat_name": cat_name, "products": products}


# ────────────────────────────────────────────────────────────────────
# カテゴリ → Supabase のカテゴリ名マッピング
# ────────────────────────────────────────────────────────────────────
CATEGORY_MAP = {
    # トクバイのカテゴリ名キーワード → Supabase の category 値
    "野菜":     "食品",
    "果物":     "食品",
    "肉":       "食品",
    "魚":       "食品",
    "海産":     "食品",
    "乳製品":   "食品",
    "豆腐":     "食品",
    "加工食品": "食品",
    "惣菜":     "食品",
    "米":       "食品",
    "パン":     "食品",
    "麺":       "食品",
    "調味料":   "食品",
    "冷凍":     "食品",
    "飲料":     "飲料",
    "お茶":     "飲料",
    "コーヒー": "飲料",
    "お酒":     "飲料",
    "酒":       "飲料",
    "日用品":   "日用品",
    "洗剤":     "日用品",
    "ペット":   "日用品",
    "美容":     "日用品",
    "化粧":     "日用品",
    "医薬":     "薬品",
    "薬":       "薬品",
    "サプリ":   "薬品",
    "台所":     "台所用品",
    "キッチン": "台所用品",
}


def guess_category(cat_name: str) -> str:
    if not cat_name:
        return "食品"
    for kw, cat in CATEGORY_MAP.items():
        if kw in cat_name:
            return cat
    return "食品"


# ────────────────────────────────────────────────────────────────────
# Supabase 書き込み
# ────────────────────────────────────────────────────────────────────
def get_existing_data(supabase) -> tuple[dict, dict]:
    """既存の product_groups と product_aliases を取得"""
    pg_res = supabase.table("product_groups").select("id, canonical_name").execute()
    groups = {r["canonical_name"]: r["id"] for r in (pg_res.data or [])}

    pa_res = supabase.table("product_aliases").select("alias, group_id").execute()
    aliases = {r["alias"]: r["group_id"] for r in (pa_res.data or [])}

    return groups, aliases


def upsert_product(supabase, product_name: str, cat_name: str,
                   groups: dict, aliases: dict, dry_run: bool) -> int:
    """
    商品名を product_groups / product_aliases に登録する。
    戻り値: 追加したエイリアス数
    """
    category    = guess_category(cat_name)
    subcategory = cat_name or ""

    # product_groups に存在しなければ作成
    if product_name not in groups:
        if not dry_run:
            res = supabase.table("product_groups").insert({
                "canonical_name": product_name,
                "category":       category,
                "subcategory":    subcategory,
            }).execute()
            group_id = res.data[0]["id"] if res.data else None
        else:
            group_id = f"(dry-run:{product_name})"

        if group_id:
            groups[product_name] = group_id
            print(f"    + product_groups: {product_name} [{category}/{subcategory}]")
    else:
        group_id = groups[product_name]

    if not group_id:
        return 0

    # エイリアスを生成して未登録のものだけ insert
    alias_list = generate_aliases(product_name)
    new_aliases = [a for a in alias_list if a not in aliases]

    if new_aliases:
        rows = [{"group_id": group_id, "alias": a, "source": "tokubai_category"}
                for a in new_aliases]
        if not dry_run:
            # 20件ずつ insert
            for i in range(0, len(rows), 20):
                supabase.table("product_aliases").insert(rows[i:i+20]).execute()
        for a in new_aliases:
            aliases[a] = group_id
        print(f"    + aliases ({len(new_aliases)}件): {new_aliases[:5]}{'...' if len(new_aliases)>5 else ''}")

    return len(new_aliases)


# ────────────────────────────────────────────────────────────────────
# メイン
# ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="DBに書き込まず確認のみ")
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("❌  .env に SUPABASE_URL と SUPABASE_SERVICE_KEY を設定してください")
        return

    supabase = create_client(url, key)
    print("✓ Supabase 接続OK")
    if args.dry_run:
        print("=== DRY RUN モード（DBへの書き込みなし）===\n")

    # 既存データ取得
    groups, aliases = get_existing_data(supabase)
    print(f"  既存 product_groups: {len(groups)} 件")
    print(f"  既存 product_aliases: {len(aliases)} 件\n")

    total_groups  = 0
    total_aliases = 0

    with httpx.Client(headers=HEADERS, follow_redirects=True) as client:
        for cat_id in CATEGORY_IDS:
            print(f"\n--- product_categories/{cat_id} ---")
            result = fetch_category_page(client, cat_id)
            time.sleep(SLEEP_SEC)

            cat_name = result["cat_name"] or f"カテゴリ{cat_id}"

            for product_name in result["products"]:
                if not product_name or len(product_name) < 2:
                    continue

                before_groups = len(groups)
                added = upsert_product(
                    supabase, product_name, cat_name,
                    groups, aliases, args.dry_run
                )
                if len(groups) > before_groups:
                    total_groups += 1
                total_aliases += added

    # ビュー更新
    if not args.dry_run:
        print("\nマテリアライズドビュー更新中...")
        try:
            supabase.rpc("refresh_price_view", {}).execute()
            print("✓ 更新完了")
        except Exception as e:
            print(f"  ビュー更新失敗: {e}")

    print(f"""
============================================================
完了
  新規 product_groups:  {total_groups} 件
  新規 product_aliases: {total_aliases} 件
  合計 product_groups:  {len(groups)} 件
  合計 product_aliases: {len(aliases)} 件
============================================================""")


if __name__ == "__main__":
    main()
