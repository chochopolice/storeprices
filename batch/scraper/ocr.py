"""
ocr.py  ─  Google Cloud Vision API OCR 層

月 1000 枚まで無料（2024年時点）。
超過すると 1000 枚ごと $1.50 かかるため、
ocr_done フラグで同じ画像を 2 度 OCR しない設計にしています。
"""

import os

import httpx

VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate"


def _get_supabase():
    """遅延 import（Supabase キーが設定されていない場合でも import エラーにしない）"""
    from supabase import create_client
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


async def process_new_flyers(max_count: int = 50) -> list[dict]:
    """
    flyers テーブルで未処理（ocr_done=false）の画像を OCR する。

    Args:
        max_count: 1回の実行で OCR する最大枚数（コスト上限）

    Returns:
        [{"raw_name": str, "price": int, "store_id": str, ...}, ...]
    """
    api_key = os.environ.get("GOOGLE_VISION_KEY", "")
    if not api_key:
        print("  GOOGLE_VISION_KEY が未設定 → OCR をスキップ")
        return []

    supabase = _get_supabase()

    # 未処理チラシを新しい順に取得
    res = (
        supabase.table("flyers")
        .select("id, store_id, image_url")
        .eq("ocr_done", False)
        .order("fetched_at", desc=True)
        .limit(max_count)
        .execute()
    )
    flyers = res.data or []
    print(f"  OCR 対象: {len(flyers)}枚")

    results: list[dict] = []

    async with httpx.AsyncClient(timeout=30) as client:
        for flyer in flyers:
            ocr_text = await _call_vision_api(client, flyer["image_url"], api_key)

            if ocr_text:
                from scraper.parser import parse_ocr_text
                parsed = parse_ocr_text(ocr_text, flyer["store_id"])
                results.extend(parsed)

            # OCR 済みフラグを立てる（同じ画像を 2 度 OCR しない）
            supabase.table("flyers").update(
                {"ocr_done": True, "ocr_text": ocr_text or ""}
            ).eq("id", flyer["id"]).execute()

    print(f"  OCR 完了: {len(results)}件抽出")
    return results


async def _call_vision_api(
    client: httpx.AsyncClient,
    image_url: str,
    api_key: str,
) -> str | None:
    """
    Google Cloud Vision API を呼び出して OCR テキストを返す。

    Args:
        image_url: 公開されている画像の URL
        api_key:   Google Cloud API キー

    Returns:
        認識されたテキスト全体、または None（失敗時）
    """
    payload = {
        "requests": [
            {
                "image": {"source": {"imageUri": image_url}},
                "features": [{"type": "TEXT_DETECTION", "maxResults": 1}],
                "imageContext": {"languageHints": ["ja"]},  # 日本語優先
            }
        ]
    }

    try:
        r = await client.post(
            f"{VISION_API_URL}?key={api_key}",
            json=payload,
        )
        r.raise_for_status()
        data = r.json()
        annotations = data["responses"][0].get("textAnnotations", [])
        if not annotations:
            return None
        return annotations[0]["description"]

    except httpx.HTTPStatusError as e:
        # 429 = レート制限、403 = APIキー不正
        print(f"    Vision API HTTP エラー {e.response.status_code}: {image_url}")
        return None
    except Exception as e:
        print(f"    Vision API エラー: {e}")
        return None


async def count_monthly_ocr_usage() -> int:
    """
    今月の OCR 実行枚数を集計する（無料枠監視用）。

    Returns:
        今月 OCR 済みの枚数
    """
    from datetime import date

    supabase = _get_supabase()
    month_start = date.today().replace(day=1).isoformat()

    res = (
        supabase.table("flyers")
        .select("id", count="exact")
        .eq("ocr_done", True)
        .gte("fetched_at", month_start)
        .execute()
    )
    return res.count or 0
