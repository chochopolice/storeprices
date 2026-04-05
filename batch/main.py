"""
main.py  ─  週次価格取得バッチ エントリーポイント

GitHub Actions の weekly_scrape.yml から呼び出されます。
ローカルでのテスト時は batch/ ディレクトリで:
    python main.py
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


async def main() -> None:
    print("=" * 50)
    print("週次価格取得バッチ 開始")
    print("=" * 50)

    enable_ocr    = os.environ.get("ENABLE_OCR", "false").lower() == "true"
    max_ocr_count = int(os.environ.get("MAX_OCR_PER_RUN", "50"))
    supabase_url  = os.environ.get("SUPABASE_URL", "")

    if not supabase_url:
        print("\n⚠️  SUPABASE_URL が未設定です。")
        _run_dry_mode()
        return

    # ── Supabase から店舗一覧を動的取得 ───────────────────────────
    # stores テーブルの store_code = tokubai の店舗ID
    # STORE_MAPPING のハードコードは不要
    from supabase import create_client
    supabase = create_client(supabase_url, os.environ["SUPABASE_SERVICE_KEY"])

    print("\n[準備] Supabase から店舗一覧を取得...")
    res = supabase.table("stores").select("id, name, store_code").execute()
    stores_in_db = [s for s in (res.data or []) if s.get("store_code")]

    if not stores_in_db:
        print("⚠️  stores テーブルに store_code が設定された店舗がありません。")
        print("   tokubai_ichikawa_scraper.py を先に実行してください。")
        return

    # STORE_MAPPING 形式に変換（既存コードと互換）
    store_mapping = [
        {
            "tokubai_id":  s["store_code"],
            "supabase_id": s["id"],
            "name":        s["name"],
        }
        for s in stores_in_db
    ]
    print(f"  対象店舗: {len(store_mapping)} 件")
    for s in store_mapping:
        print(f"    {s['tokubai_id']:>8}  {s['name']}")

    # ── OCR コスト監視 ─────────────────────────────────────────────
    if enable_ocr:
        from scraper.ocr import count_monthly_ocr_usage
        monthly_count = await count_monthly_ocr_usage()
        print(f"\n今月の OCR 実行枚数: {monthly_count}/1000")
        if monthly_count >= 900:
            print("⚠️  月次 OCR 上限（900枚）に達しました → OCR をスキップ")
            enable_ocr = False

    all_observations: list[dict] = []

    # ── Step 1: HTML テキストスクレイピング ────────────────────────
    print(f"\n[Step 1] HTML スクレイピング ({len(store_mapping)} 店舗)")
    from scraper.tokubai import fetch_store_prices, fetch_flyer_image_urls
    from scraper.uploader import register_new_flyers

    for store in store_mapping:
        print(f"\n  処理中: {store['name']} (tokubai_id={store['tokubai_id']})")

        text_prices = await fetch_store_prices(store["tokubai_id"])
        all_observations.extend([
            {**p, "store_id": store["supabase_id"], "source_type": "html_scrape"}
            for p in text_prices
        ])

        if enable_ocr:
            img_urls = await fetch_flyer_image_urls(store["tokubai_id"])
            await register_new_flyers(store["supabase_id"], img_urls)

    # ── Step 2: OCR ───────────────────────────────────────────────
    if enable_ocr:
        print(f"\n[Step 2] チラシ OCR (最大 {max_ocr_count} 枚)")
        from scraper.ocr import process_new_flyers
        ocr_results = await process_new_flyers(max_count=max_ocr_count)
        all_observations.extend(ocr_results)
    else:
        print("\n[Step 2] OCR スキップ（ENABLE_OCR=false）")

    # ── Step 3: DB 書き込み ────────────────────────────────────────
    print(f"\n[Step 3] DB 書き込み ({len(all_observations)}件)")
    from scraper.uploader import upload_to_supabase, refresh_view
    await upload_to_supabase(all_observations)

    # ── Step 4: マテリアライズドビュー更新 ────────────────────────
    print("\n[Step 4] ビュー更新")
    await refresh_view()

    print("\n" + "=" * 50)
    print(f"完了: 合計 {len(all_observations)} 件を処理しました")
    print("=" * 50)


def _run_dry_mode() -> None:
    print("[ドライランモード] OCR パーサーのテストを実行します...\n")

    from scraper.parser import parse_ocr_text
    from scraper.normalizer import normalize_text

    SAMPLE_OCR = """
本日の特売品
絹豆腐
88円
木綿豆腐 ¥78
牛乳1L
198円（税込）
卵Mサイズ10個=228円
サラダチキン ¥198
    """

    print("=== パーサーテスト ===")
    results = parse_ocr_text(SAMPLE_OCR, "test-store-id")
    for item in results:
        print(f"  {item['raw_name']:25s}  {item['price']}円")

    print("\n=== 正規化テスト ===")
    test_words = ["絹豆腐", "木綿豆腐", "とうふ", "トウフ", "牛　乳", "TOFU"]
    for word in test_words:
        print(f"  '{word:10s}' → '{normalize_text(word)}'")

    print("\nドライランモード完了。Supabase 接続なしで動作確認できました。")


if __name__ == "__main__":
    asyncio.run(main())
