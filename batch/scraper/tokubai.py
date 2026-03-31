"""
tokubai.py  ─  トクバイ HTML スクレイピング層

【重要】実行前に必ず確認すること
  1. https://tokubai.co.jp/robots.txt を確認
  2. 利用規約の「データの利用」条項を確認
  3. 禁止されている場合はこのモジュールを使用しないこと

セレクタは実際の HTML 構造に合わせて調整が必要です。
ブラウザの開発者ツール (F12) で確認してください。
"""

import asyncio
import re
import urllib.robotparser
from datetime import date

import httpx
from bs4 import BeautifulSoup

TOKUBAI_BASE = "https://tokubai.co.jp"

# robots.txt キャッシュ（1回だけ取得）
_rp: urllib.robotparser.RobotFileParser | None = None
_USER_AGENT = "PriceBot/1.0 (+mailto:your@email.com)"


async def _get_robots() -> urllib.robotparser.RobotFileParser:
    """robots.txt を取得してパース（初回のみ）"""
    global _rp
    if _rp is not None:
        return _rp

    _rp = urllib.robotparser.RobotFileParser()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{TOKUBAI_BASE}/robots.txt")
            _rp.parse(r.text.splitlines())
    except Exception as e:
        print(f"  robots.txt 取得失敗（許可側でフォールバック）: {e}")
        # 取得できない場合は許可として扱う（保守的にしたい場合は False を返す）
    return _rp


async def is_allowed(path: str) -> bool:
    """robots.txt でアクセス許可されているか確認"""
    rp = await _get_robots()
    return rp.can_fetch(_USER_AGENT, f"{TOKUBAI_BASE}{path}")


# ─────────────────────────────────────────────
# 店舗マッピング設定
# stores.json の supabase_id と tokubai_store_id を対応させる
# tokubai_store_id はブラウザで store ページの URL から確認する
#   例: https://tokubai.co.jp/stores/12345  → "12345"
# ─────────────────────────────────────────────
STORE_MAPPING: list[dict] = [
    # {
    #     "tokubai_id":  "12345",        # トクバイの店舗ID
    #     "supabase_id": "uuid-s001",    # Supabase stores テーブルの id
    #     "name":        "Selection FOODS MARKET",
    # },
    # 実際の店舗を追加してください
]


async def fetch_store_prices(tokubai_store_id: str) -> list[dict]:
    """
    トクバイの商品ページからテキスト価格を抽出する。

    Returns:
        [{"raw_name": str, "price": int, "raw_text": str, "source_url": str}, ...]
    """
    path = f"/stores/{tokubai_store_id}/products"

    if not await is_allowed(path):
        print(f"  robots.txt Disallow: {path} → スキップ")
        return []

    url = f"{TOKUBAI_BASE}{path}"
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept-Language": "ja,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
    }

    async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
        try:
            r = await client.get(url)
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            print(f"  HTTP {e.response.status_code}: {url}")
            return []
        except httpx.RequestError as e:
            print(f"  接続エラー: {e}")
            return []

    soup = BeautifulSoup(r.text, "lxml")
    results = []

    # ─────────────────────────────────────────────────────────────
    # ★ ここのセレクタはトクバイの実際の HTML 構造に合わせて要修正 ★
    # ブラウザで https://tokubai.co.jp/stores/{id}/products を開き
    # F12 → 要素を選択して class 名を確認してください。
    # ─────────────────────────────────────────────────────────────
    CARD_SELECTORS  = [".product-card", "[data-testid='product-item']", ".item-card"]
    NAME_SELECTORS  = [".product-name", "[data-testid='product-name']", ".item-name", "h3", "h4"]
    PRICE_SELECTORS = [".product-price", "[data-testid='price']", ".price", ".item-price"]

    for card_sel in CARD_SELECTORS:
        cards = soup.select(card_sel)
        if not cards:
            continue

        for card in cards:
            name_el  = _first_match(card, NAME_SELECTORS)
            price_el = _first_match(card, PRICE_SELECTORS)

            if not name_el or not price_el:
                continue

            name       = name_el.get_text(strip=True)
            price_text = price_el.get_text(strip=True)
            price      = _extract_price(price_text)

            if price is None:
                continue

            results.append({
                "raw_name":   name,
                "price":      price,
                "raw_text":   f"{name} {price_text}",
                "source_url": url,
            })

        if results:
            break  # いずれかのセレクタでヒットしたら終了

    print(f"  テキスト取得: {len(results)}件 ({url})")
    return results


async def fetch_flyer_image_urls(tokubai_store_id: str) -> list[str]:
    """
    チラシ画像 URL の一覧を取得する（OCR 対象リスト作成用）。

    Returns:
        [image_url, ...]
    """
    path = f"/stores/{tokubai_store_id}/flyers"

    if not await is_allowed(path):
        print(f"  robots.txt Disallow: {path} → スキップ")
        return []

    url = f"{TOKUBAI_BASE}{path}"
    headers = {"User-Agent": _USER_AGENT}

    async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
        try:
            r = await client.get(url)
            r.raise_for_status()
        except Exception as e:
            print(f"  チラシページ取得失敗: {e}")
            return []

    soup = BeautifulSoup(r.text, "lxml")

    # ─────────────────────────────────────────────────────────────
    # ★ チラシ画像のセレクタも実際の HTML に合わせて要修正 ★
    # ─────────────────────────────────────────────────────────────
    img_urls: list[str] = []
    for img in soup.select(".flyer-image img, [data-testid='flyer-image'], .flyer img"):
        src = img.get("src") or img.get("data-src")
        if src and src.startswith("http"):
            img_urls.append(src)

    print(f"  チラシ画像: {len(img_urls)}枚 ({url})")
    return img_urls


# ─────────────────────────────────────────────
# ヘルパー
# ─────────────────────────────────────────────

def _first_match(parent: BeautifulSoup, selectors: list[str]):
    """複数セレクタを順に試して最初にヒットした要素を返す"""
    for sel in selectors:
        el = parent.select_one(sel)
        if el:
            return el
    return None


def _extract_price(price_text: str) -> int | None:
    """
    価格テキストから整数価格を抽出する。
    対応フォーマット例:
      "¥198"  "198円"  "税込198円"  "198(税込)"  "1,280円"
    """
    # カンマを除去してから数字列を探す
    cleaned = price_text.replace(",", "")
    m = re.search(r"(\d{2,5})", cleaned)
    if not m:
        return None
    price = int(m.group(1))
    # 異常値除外
    if price < 30 or price > 99999:
        return None
    return price
