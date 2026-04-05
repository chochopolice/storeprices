"""
tokubai.py  ─  トクバイ HTML スクレイピング層

【重要】実行前に必ず確認すること
  1. https://tokubai.co.jp/robots.txt を確認
  2. 利用規約の「データの利用」条項を確認

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  トクバイ店舗IDの調べ方（STORE_MAPPING 設定手順）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. https://tokubai.co.jp を開く
  2. 店舗名で検索（例: "行徳" "南行徳"）
  3. 店舗ページに遷移したときのURLを確認
       例: https://tokubai.co.jp/stores/12345
                                         ^^^^^ これが tokubai_id
  4. 下の STORE_MAPPING に追加する

  Supabase の supabase_id は:
    Supabase ダッシュボード → Table Editor → stores テーブル
    → 対象店舗の id 列をコピー
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import asyncio
import re
import urllib.robotparser
from datetime import date

import httpx
from bs4 import BeautifulSoup

TOKUBAI_BASE = "https://tokubai.co.jp"
_USER_AGENT  = "PriceBot/1.0 (+mailto:your@email.com)"

# robots.txt キャッシュ（1回だけ取得）
_rp: urllib.robotparser.RobotFileParser | None = None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  ★ 行徳・南行徳エリアの店舗マッピング設定
#
#  tokubai_id の調べ方は上のコメントを参照してください。
#  supabase_id は Supabase に stores データを登録後に設定します。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STORE_MAPPING: list[dict] = [
    {
        "tokubai_id":  "",          # TODO: トクバイのURLで確認して入力
        "supabase_id": "",          # TODO: Supabase stores テーブルの id
        "name":        "イオン 市川妙典店",
        "area":        "妙典",
        "memo":        "妙典駅徒歩1分",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "マルエツ 行徳店",
        "area":        "行徳",
        "memo":        "行徳駅徒歩3分",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "ライフ 南行徳店",
        "area":        "南行徳",
        "memo":        "南行徳駅徒歩5分",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "業務スーパー 南行徳店",
        "area":        "南行徳",
        "memo":        "南行徳駅徒歩8分",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "ウエルシア薬局 行徳駅前店",
        "area":        "行徳",
        "memo":        "行徳駅前",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "マツモトキヨシ 南行徳店",
        "area":        "南行徳",
        "memo":        "南行徳駅徒歩2分",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "Selection FOODS MARKET",
        "area":        "妙典・行徳",
        "memo":        "地域密着型スーパー",
    },
    {
        "tokubai_id":  "",
        "supabase_id": "",
        "name":        "東武ストア 行徳店",
        "area":        "行徳",
        "memo":        "行徳駅直結",
    },
]


async def _get_robots() -> urllib.robotparser.RobotFileParser:
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
    return _rp


async def is_allowed(path: str) -> bool:
    rp = await _get_robots()
    return rp.can_fetch(_USER_AGENT, f"{TOKUBAI_BASE}{path}")


async def fetch_store_prices(tokubai_store_id: str) -> list[dict]:
    """
    トクバイの商品ページからテキスト価格を抽出する。
    """
    if not tokubai_store_id:
        print("  tokubai_id が未設定 → スキップ")
        return []

    # 店舗ページURL: https://tokubai.co.jp/{store_id}
    url = f"{TOKUBAI_BASE}/{tokubai_store_id}"
    path = f"/{tokubai_store_id}"
    if not await is_allowed(path):
        print(f"  robots.txt Disallow: {path} → スキップ")
        return []

    headers = {
        "User-Agent":      _USER_AGENT,
        "Accept-Language": "ja,en;q=0.9",
        "Accept":          "text/html,application/xhtml+xml",
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

    # トクバイ店舗ページの商品カード構造に合わせて抽出
    # セレクタはブラウザ F12 で確認した実際の構造に基づく
    CARD_SELECTORS  = [
        ".sale-item", ".product-item", ".item",
        "[class*='SaleItem']", "[class*='ProductItem']",
    ]
    NAME_SELECTORS  = [
        ".sale-item__name", ".product-name", ".item__name",
        "[class*='itemName']", "[class*='productName']", "h3", "h4",
    ]
    PRICE_SELECTORS = [
        ".sale-item__price", ".product-price", ".item__price",
        "[class*='itemPrice']", "[class*='price']",
    ]

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
            break

    print(f"  テキスト取得: {len(results)}件 ({url})")
    return results


async def fetch_flyer_image_urls(tokubai_store_id: str) -> list[str]:
    """チラシ画像 URL の一覧を取得する（OCR 対象リスト作成用）"""
    if not tokubai_store_id:
        return []

    # チラシ一覧URL: https://tokubai.co.jp/{store_id}/leaflets/
    url = f"{TOKUBAI_BASE}/{tokubai_store_id}/leaflets/"
    path = f"/{tokubai_store_id}/leaflets/"
    if not await is_allowed(path):
        print(f"  robots.txt Disallow: {path} → スキップ")
        return []

    headers = {"User-Agent": _USER_AGENT}

    async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
        try:
            r = await client.get(url)
            r.raise_for_status()
        except Exception as e:
            print(f"  チラシページ取得失敗: {e}")
            return []

    soup = BeautifulSoup(r.text, "lxml")
    img_urls: list[str] = []

    # チラシ画像セレクタ（トクバイの実際の構造）
    for img in soup.select(
        ".leaflet img, .flyer img, [class*='leaflet'] img, [class*='Leaflet'] img"
    ):
        src = img.get("src") or img.get("data-src") or img.get("data-lazy-src")
        if src and src.startswith("http") and not src.endswith(".gif"):
            img_urls.append(src)

    # チラシへのリンクから画像URLを補完
    if not img_urls:
        for a in soup.select(f"a[href*='/{tokubai_store_id}/leaflets/']"):
            href = a.get("href", "")
            if href and "/leaflets/" in href:
                img = a.select_one("img")
                if img:
                    src = img.get("src") or img.get("data-src")
                    if src and src.startswith("http"):
                        img_urls.append(src)

    print(f"  チラシ画像: {len(img_urls)}枚 ({url})")
    return img_urls


# ─────────────────────────────────────────────
# STORE_MAPPING の設定状況を確認するユーティリティ
# python -m scraper.tokubai で実行
# ─────────────────────────────────────────────
def check_mapping_status() -> None:
    """STORE_MAPPING の設定状況を一覧表示する"""
    print("=" * 60)
    print("行徳・南行徳エリア 店舗マッピング設定状況")
    print("=" * 60)
    configured = 0
    for store in STORE_MAPPING:
        has_tokubai = bool(store.get("tokubai_id"))
        has_supabase = bool(store.get("supabase_id"))
        status = "✓ 完了" if (has_tokubai and has_supabase) else \
                 "⚠ 一部" if (has_tokubai or has_supabase) else \
                 "✗ 未設定"
        if has_tokubai and has_supabase:
            configured += 1
        print(f"  [{status}] {store['name']}")
        if not has_tokubai:
            print(f"           → tokubai_id を設定してください")
        if not has_supabase:
            print(f"           → supabase_id を設定してください（Supabase登録後）")
    print()
    print(f"  設定完了: {configured}/{len(STORE_MAPPING)} 店舗")
    print("=" * 60)


# ─────────────────────────────────────────────
# ヘルパー
# ─────────────────────────────────────────────
def _first_match(parent, selectors: list[str]):
    for sel in selectors:
        el = parent.select_one(sel)
        if el:
            return el
    return None


def _extract_price(price_text: str) -> int | None:
    cleaned = price_text.replace(",", "")
    m = re.search(r"(\d{2,5})", cleaned)
    if not m:
        return None
    price = int(m.group(1))
    if price < 30 or price > 99999:
        return None
    return price


if __name__ == "__main__":
    check_mapping_status()
