"""
uploader.py  ─  Supabase 書き込み層

1. raw_price_observations に全件 insert
2. group_id が付いているものは normalized_prices にも upsert
3. マテリアライズドビューを REFRESH してフロントに反映
"""

import os
from datetime import date


def _get_supabase():
    from supabase import create_client
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


async def upload_to_supabase(observations: list[dict]) -> None:
    """
    observations を DB に書き込む。

    Args:
        observations: scraper / OCR から得た生データリスト
    """
    from scraper.normalizer import enrich_observations

    if not observations:
        print("  書き込みデータなし → スキップ")
        return

    supabase = _get_supabase()
    today = date.today().isoformat()

    # group_id を付与
    enriched = enrich_observations(observations)

    # ── raw_price_observations ────────────────────────────────────
    raw_rows = [
        {
            "store_id":    obs["store_id"],
            "price":       obs["price"],
            "raw_text":    obs.get("raw_text", ""),
            "source_type": obs.get("source_type", "unknown"),
            "observed_at": today,
        }
        for obs in enriched
    ]

    if raw_rows:
        # insert（重複は on_conflict で無視）
        supabase.table("raw_price_observations").insert(raw_rows).execute()
        print(f"  raw_price_observations: {len(raw_rows)}件 insert")

    # ── normalized_prices ─────────────────────────────────────────
    # group_id があるものだけ upsert（store_id + group_id + valid_from で一意）
    norm_rows = [
        {
            "store_id":         obs["store_id"],
            "product_group_id": obs["product_group_id"],
            "price":            obs["price"],
            "valid_from":       today,
            "is_sale":          False,  # チラシ価格は仮に False（将来: 赤字チラシ判定）
        }
        for obs in enriched
        if obs.get("product_group_id")
    ]

    if norm_rows:
        supabase.table("normalized_prices").upsert(
            norm_rows,
            on_conflict="store_id,product_group_id,valid_from",
        ).execute()
        print(f"  normalized_prices: {len(norm_rows)}件 upsert")


async def refresh_view() -> None:
    """
    マテリアライズドビュー latest_store_product_prices を更新する。
    Supabase の RPC 関数経由で実行（直接 SQL は Service Role が必要）。

    Supabase SQL Editor で事前に作成しておく関数:
        CREATE OR REPLACE FUNCTION refresh_price_view()
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN
          REFRESH MATERIALIZED VIEW CONCURRENTLY latest_store_product_prices;
        END;
        $$;
    """
    try:
        supabase = _get_supabase()
        supabase.rpc("refresh_price_view", {}).execute()
        print("  マテリアライズドビュー更新完了")
    except Exception as e:
        print(f"  ビュー更新失敗（手動で REFRESH が必要）: {e}")


async def register_new_flyers(store_id: str, image_urls: list[str]) -> None:
    """
    新しいチラシ画像 URL を flyers テーブルに登録する。
    すでに存在する URL はスキップ（重複 OCR 防止）。

    Args:
        store_id:   Supabase stores テーブルの store_id
        image_urls: fetch_flyer_image_urls() が返した URL リスト
    """
    if not image_urls:
        return

    supabase = _get_supabase()

    # 既存 URL を取得して差分だけ insert
    existing_res = (
        supabase.table("flyers")
        .select("image_url")
        .eq("store_id", store_id)
        .execute()
    )
    existing_urls = {r["image_url"] for r in (existing_res.data or [])}

    new_rows = [
        {
            "store_id":  store_id,
            "image_url": url,
            "ocr_done":  False,
        }
        for url in image_urls
        if url not in existing_urls
    ]

    if new_rows:
        supabase.table("flyers").insert(new_rows).execute()
        print(f"  flyers: {len(new_rows)}件 追加登録")
    else:
        print("  flyers: 新規チラシなし")
