"""
normalizer.py  ─  商品名 → product_group 名寄せ

app.js の normalize() / isLooseMatch() と同じロジックを Python で実装し、
フロントとバッチで一貫した検索体験を保ちます。
"""

import re
import unicodedata
from functools import lru_cache
import os


def normalize_text(text: str) -> str:
    """
    app.js の normalize() と同じ処理。
      - NFKC 正規化（全角→半角変換を含む）
      - 小文字化
      - 前後の空白除去
      - スペース・ハイフン・アンダースコアを除去
    """
    text = unicodedata.normalize("NFKC", str(text or ""))
    text = text.strip().lower()
    text = re.sub(r"[\s　\-ー_]+", "", text)
    return text


@lru_cache(maxsize=1)
def get_aliases_map() -> dict[str, str]:
    """
    product_aliases テーブルを全件取得してキャッシュする。
    戻り値: { normalize(alias) → group_id }

    バッチ実行中は1回だけ DB にアクセスする。
    lru_cache で同一プロセス内はキャッシュが効く。
    """
    from supabase import create_client

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    res = supabase.table("product_aliases").select("alias, group_id").execute()

    mapping = {}
    for row in (res.data or []):
        key = normalize_text(row["alias"])
        if key:
            mapping[key] = row["group_id"]

    print(f"  エイリアス読み込み: {len(mapping)}件")
    return mapping


def find_group_id(raw_name: str) -> str | None:
    """
    商品名から product_group_id を返す。

    検索順序:
      1. 完全一致（最優先）
      2. alias が商品名に含まれる（前方/後方一致）
      3. 商品名が alias に含まれる（逆方向部分一致）

    Returns:
        group_id (str) または None（未知商品）
    """
    try:
        aliases = get_aliases_map()
    except Exception as e:
        print(f"  エイリアス取得失敗: {e}")
        return None

    normalized = normalize_text(raw_name)

    # 1. 完全一致
    if normalized in aliases:
        return aliases[normalized]

    # 2. alias が商品名に含まれる（"絹豆腐" → alias "豆腐" がヒット）
    for alias, group_id in aliases.items():
        if alias and alias in normalized:
            return group_id

    # 3. 商品名が alias に含まれる（短い商品名がより長い alias にマッチ）
    for alias, group_id in aliases.items():
        if alias and normalized in alias:
            return group_id

    return None


def enrich_observations(observations: list[dict]) -> list[dict]:
    """
    raw_price_observations の各レコードに group_id を付与する。

    Args:
        observations: [{"raw_name": str, "price": int, ...}, ...]

    Returns:
        group_id が付いたレコードのみ（未知商品は unknown_names に記録）
    """
    enriched: list[dict] = []
    unknown_names: list[str] = []

    for obs in observations:
        group_id = find_group_id(obs.get("raw_name", ""))

        if group_id:
            enriched.append({**obs, "product_group_id": group_id})
        else:
            unknown_names.append(obs.get("raw_name", ""))

    if unknown_names:
        preview = unknown_names[:5]
        print(f"  名寄せ不可: {len(unknown_names)}件 → 例: {preview}")
        # TODO: 未知商品を product_alias_candidates テーブルに保存して
        #       手動確認できるようにすると品質が上がります

    return enriched
