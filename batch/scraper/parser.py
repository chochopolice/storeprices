"""
parser.py  ─  OCR テキスト → 構造化データ変換

チラシのレイアウトは店舗・チェーンによって異なるため、
複数の正規表現パターンを試してマッチ率を上げます。
"""

import re


# ─────────────────────────────────────────────────────────────
# 価格パターン
# チラシでよく出るフォーマットを網羅しています。
# 実際のOCR結果に合わせて随時追加・調整してください。
# ─────────────────────────────────────────────────────────────
PRICE_PATTERNS: list[tuple[str, int, int]] = [
    # (pattern, name_group, price_group)
    # パターン1: "商品名\n198円" or "商品名 198円"
    (r"([^\n¥\d]{2,20})\s*\n\s*(\d{2,4})\s*円",          1, 2),
    # パターン2: "商品名 ¥198"
    (r"([^\n¥\d]{2,20})\s+¥\s*(\d{2,4})",                  1, 2),
    # パターン3: "商品名 198(税込)" or "198（税込）"
    (r"([^\n¥\d]{2,20})\s+(\d{2,4})\s*[（(]税込[）)]",     1, 2),
    # パターン4: "商品名=198円"
    (r"([^\n¥\d]{2,20})\s*[=＝]\s*(\d{2,4})\s*円",         1, 2),
    # パターン5: 価格が先行 "198円 商品名"（一部チラシ）
    (r"(\d{2,4})\s*円\s+([^\n¥\d]{2,20})",                  2, 1),
]

# 除外パターン（商品名として不正なもの）
INVALID_NAME_PATTERNS = [
    r"^[\d\s¥円税込]+$",    # 数字・記号のみ
    r"^\s*$",               # 空文字
    r"^税",                  # 「税」から始まる
    r"^(円|¥|￥)$",        # 通貨記号のみ
    r"^\d+$",               # 数字のみ
    r"^.{1,2}切$",           # 「枚切」などの単位誤検知を除外
    r"^(パック|個|本|袋|枚|缶|本入|袋入)$",  # 単位語単体の除外
    r"^[ぁ-ん]{1}$",         # ひらがな1文字
]


def parse_ocr_text(ocr_text: str, store_id: str) -> list[dict]:
    """
    OCR テキストから商品名・価格ペアを抽出する。

    Args:
        ocr_text: Google Vision API などが返したテキスト全体
        store_id: Supabase stores テーブルの store_id

    Returns:
        [{"raw_name": str, "price": int, "raw_text": str,
          "store_id": str, "source_type": "flyer_ocr"}, ...]
    """
    results: list[dict] = []
    seen: set[tuple[str, int]] = set()  # 重複除去

    for pattern, name_group, price_group in PRICE_PATTERNS:
        for match in re.finditer(pattern, ocr_text, re.MULTILINE):
            name  = match.group(name_group).strip()
            price = int(match.group(price_group))

            # 異常値除外（50円未満・10000円超は誤検知が多い）
            if price < 50 or price > 9999:
                continue

            # 不正な商品名を除外
            if _is_invalid_name(name):
                continue

            key = (name, price)
            if key in seen:
                continue
            seen.add(key)

            results.append({
                "raw_name":    name,
                "price":       price,
                "raw_text":    match.group(0).strip(),
                "store_id":    store_id,
                "source_type": "flyer_ocr",
            })

    print(f"    パース結果: {len(results)}件")
    return results


def _is_invalid_name(name: str) -> bool:
    """商品名として不正かどうかを判定する"""
    if len(name) < 2:
        return True
    for pat in INVALID_NAME_PATTERNS:
        if re.match(pat, name):
            return True
    return False


# ─────────────────────────────────────────────────────────────
# 単体テスト用
# python -m scraper.parser でテスト実行できます
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    SAMPLE_OCR = """
    本日のお買い得品
    絹豆腐
    88円
    木綿豆腐 ¥78
    牛乳1L
    198円（税込）
    卵Mサイズ10個=228円
    """

    parsed = parse_ocr_text(SAMPLE_OCR, "test-store-id")
    for item in parsed:
        print(f"  {item['raw_name']:20s}  {item['price']}円")
