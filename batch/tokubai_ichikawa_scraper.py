#!/usr/bin/env python3
"""
Scrape Tokubai store pages for Ichikawa City (Chiba) and output rows matching:

id,chain_id,name,type,lat,lng,address,store_code,created_at

Notes
-----
- The script starts from the Ichikawa city page and crawls paginated store-list pages.
- For each discovered store detail page, it extracts:
  - name
  - type/category
  - address
  - store_code (numeric ID in the URL)
- Optional geocoding uses Nominatim (OpenStreetMap) with a 1-second delay and a custom user-agent.
- chain_id is generated deterministically from the chain slug/name via UUIDv5.
- id is generated per row via UUIDv4.

Usage example
-------------
python tokubai_ichikawa_scraper.py \
  --template stores_rows.csv \
  --output tokubai_ichikawa_stores.csv \
  --geocode
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urljoin, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup

try:
    from geopy.extra.rate_limiter import RateLimiter
    from geopy.geocoders import Nominatim
except Exception:
    Nominatim = None
    RateLimiter = None

BASE = "https://tokubai.co.jp"
CITY_URL = (
    "https://tokubai.co.jp/prefectures/12/cities/"
    "%E5%B8%82%E5%B7%9D%E5%B8%82"
)
DEFAULT_COLUMNS = [
    "id",
    "chain_id",
    "name",
    "type",
    "lat",
    "lng",
    "address",
    "store_code",
    "created_at",
]

# Covers categories shown on the Tokubai Ichikawa city page.
KNOWN_TYPES = [
    "スーパー・食料品店",
    "ドラッグストア",
    "家電量販店",
    "コンビニエンスストア",
    "ホームセンター",
    "クリーニング店",
    "100円ショップ・均一ショップ",
    "ショッピングモール",
    "衣料品店・アパレルショップ",
    "キッズ・ベビー用品店",
    "眼鏡・コンタクト用品店",
    "家具・インテリア雑貨店",
    "カー用品店",
    "ガソリンスタンド",
    "スポーツ・アウトドア用品店",
    "パン屋・ベーカリー",
    "菓子・スイーツ店",
    "惣菜・弁当屋",
    "宅配・持ち帰り",
    "酒屋・リカーショップ",
    "リユース・中古品店",
    "花屋",
    "書店・本屋",
    "ペットショップ",
    "旅行代理店",
    "美容・エステサロン",
    "リラクゼーションサロン・整体院",
    "写真用品店・写真スタジオ",
    "学習塾・習い事",
    "楽器店",
    "スポーツクラブ",
    "リフォーム・住宅設備専門店",
    "道の駅",
    "携帯電話ショップ",
    "映画館",
    "霊園・葬儀場",
    "保険代理店",
    "調剤薬局",
    "コインランドリー",
    "百貨店・デパート",
    "コスメ・バラエティショップ",
    "カーディーラー・自動車販売店",
    "レンタカー",
    "バイクショップ",
    "自転車販売店",
    "ファストフード店",
    "カフェ・喫茶店",
    "レストラン",
    "CD・DVD・レコード店",
    "住宅展示場",
    "引越し業者",
    "ハウスクリーニング・家事代行",
    "不動産会社",
    "買取専門店",
    "文具・事務用品店",
    "日帰り温泉",
    "カラオケ・まんが喫茶",
    "レジャー施設",
    "ゲームセンター・ボウリング",
    "洋服・靴修理店",
    "スポーツ団体",
    "その他のお店",
]


@dataclass
class StoreRecord:
    id: str
    chain_id: str | None
    name: str | None
    type: str | None
    lat: float | None
    lng: float | None
    address: str | None
    store_code: str
    created_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "chain_id": self.chain_id,
            "name": self.name,
            "type": self.type,
            "lat": self.lat,
            "lng": self.lng,
            "address": self.address,
            "store_code": self.store_code,
            "created_at": self.created_at,
        }


class TokubaiIchikawaScraper:
    def __init__(
        self,
        sleep_seconds: float = 0.8,
        timeout: int = 20,
        geocode: bool = False,
        geocode_cache_path: str | None = None,
        max_pages: int = 100,
    ) -> None:
        self.sleep_seconds = sleep_seconds
        self.timeout = timeout
        self.max_pages = max_pages
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "tokubai-ichikawa-scraper/1.0 "
                    "(contact: replace-with-your-email@example.com)"
                ),
                "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
            }
        )
        self.geocode_enabled = geocode and Nominatim is not None
        self.geocode_cache_path = Path(geocode_cache_path) if geocode_cache_path else None
        self.geocode_cache: dict[str, dict[str, float | None]] = {}
        if self.geocode_cache_path and self.geocode_cache_path.exists():
            try:
                self.geocode_cache = json.loads(self.geocode_cache_path.read_text(encoding="utf-8"))
            except Exception:
                self.geocode_cache = {}
        self._geolocator = None
        self._geocode_func = None
        if self.geocode_enabled:
            self._geolocator = Nominatim(user_agent=self.session.headers["User-Agent"])
            self._geocode_func = RateLimiter(
                self._geolocator.geocode,
                min_delay_seconds=1.1,
                swallow_exceptions=True,
            )

    def fetch_soup(self, url: str) -> BeautifulSoup:
        resp = self.session.get(url, timeout=self.timeout)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")

    @staticmethod
    def normalize_text(text: str | None) -> str | None:
        if text is None:
            return None
        text = re.sub(r"\s+", " ", text)
        text = text.replace("➦", "").strip()
        return text or None

    @staticmethod
    def extract_store_code(url: str) -> str | None:
        m = re.search(r"/(\d+)(?:$|[/?#])", url)
        return m.group(1) if m else None

    @staticmethod
    def extract_chain_name_from_url(url: str) -> str | None:
        path = urlparse(url).path.strip("/")
        parts = path.split("/")
        if len(parts) >= 2 and parts[1].isdigit():
            return unquote(parts[0])
        return None

    @staticmethod
    def is_store_detail_url(href: str) -> bool:
        if not href:
            return False
        path = urlparse(href).path
        if path.startswith("/prefectures/") or path.startswith("/transit/"):
            return False
        # detail pages look like /{chain}/{numeric_id}
        if not re.search(r"^/[^/]+/\d+/?$", path):
            return False
        banned_parts = (
            "/near_shops",
            "/archive/",
            "/image_announcements",
            "/recruitments",
            "/leaflet",
        )
        return not any(p in path for p in banned_parts)

    def iter_store_urls(self) -> Iterable[str]:
        seen_codes: set[str] = set()
        for page in range(1, self.max_pages + 1):
            url = CITY_URL if page == 1 else f"{CITY_URL}?page={page}"
            soup = self.fetch_soup(url)
            found_this_page: list[str] = []
            for a in soup.select("a[href]"):
                href = a.get("href", "").strip()
                if not self.is_store_detail_url(href):
                    continue
                full_url = urljoin(BASE, href)
                code = self.extract_store_code(full_url)
                if not code or code in seen_codes:
                    continue
                seen_codes.add(code)
                found_this_page.append(full_url)
            if not found_this_page:
                break
            for full_url in found_this_page:
                yield full_url
            time.sleep(self.sleep_seconds)

    @staticmethod
    def lines_from_soup(soup: BeautifulSoup) -> list[str]:
        lines = []
        for line in soup.get_text("\n", strip=True).splitlines():
            line = re.sub(r"\s+", " ", line).strip()
            if line:
                lines.append(line)
        return lines

    def extract_name(self, soup: BeautifulSoup, lines: list[str]) -> str | None:
        meta = soup.find("meta", attrs={"property": "og:title"})
        if meta and meta.get("content"):
            title = str(meta["content"])
            title = re.sub(r"のチラシ・特売情報.*$", "", title).strip()
            if title:
                return title
        for i, line in enumerate(lines):
            if line == "店舗名" and i + 1 < len(lines):
                return self.normalize_text(lines[i + 1])
        h1 = soup.find(["h1", "h2"])
        return self.normalize_text(h1.get_text(" ", strip=True)) if h1 else None

    def extract_type(self, lines: list[str]) -> str | None:
        for line in lines[:120]:
            if line in KNOWN_TYPES:
                return line
        text = "\n".join(lines[:180])
        for item in sorted(KNOWN_TYPES, key=len, reverse=True):
            if item in text:
                return item
        return None

    def extract_address(self, lines: list[str]) -> str | None:
        for i, line in enumerate(lines):
            if line == "住所":
                for candidate in lines[i + 1 : i + 6]:
                    if candidate.startswith("〒") or "市川市" in candidate:
                        candidate = re.sub(r"^〒\d{3}-\d{4}\s*", "", candidate)
                        candidate = candidate.replace("千葉県 ", "千葉県")
                        return self.normalize_text(candidate)
        text = "\n".join(lines)
        m = re.search(r"住所\s*〒\d{3}-\d{4}\s*([^\n]+)", text)
        if m:
            candidate = re.sub(r"^〒\d{3}-\d{4}\s*", "", m.group(1))
            return self.normalize_text(candidate)
        return None

    def geocode_address(self, address: str | None) -> tuple[float | None, float | None]:
        if not address or not self.geocode_enabled or self._geocode_func is None:
            return None, None
        if address in self.geocode_cache:
            item = self.geocode_cache[address]
            return item.get("lat"), item.get("lng")
        try:
            location = self._geocode_func(address)
        except Exception:
            location = None
        lat = float(location.latitude) if location else None
        lng = float(location.longitude) if location else None
        self.geocode_cache[address] = {"lat": lat, "lng": lng}
        if self.geocode_cache_path:
            self.geocode_cache_path.write_text(
                json.dumps(self.geocode_cache, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        return lat, lng

    def parse_store_page(self, url: str) -> StoreRecord:
        soup = self.fetch_soup(url)
        lines = self.lines_from_soup(soup)
        store_code = self.extract_store_code(url) or ""
        chain_name = self.extract_chain_name_from_url(url)
        address = self.extract_address(lines)
        lat, lng = self.geocode_address(address)
        return StoreRecord(
            id=str(uuid.uuid4()),
            chain_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, chain_name)) if chain_name else None,
            name=self.extract_name(soup, lines),
            type=self.extract_type(lines),
            lat=lat,
            lng=lng,
            address=address,
            store_code=store_code,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    def scrape(self, limit: int | None = None) -> list[dict]:
        rows: list[dict] = []
        for idx, store_url in enumerate(self.iter_store_urls(), start=1):
            try:
                record = self.parse_store_page(store_url)
                rows.append(record.to_dict())
                print(f"[{idx}] OK  {record.store_code} {record.name}")
            except Exception as e:
                print(f"[{idx}] NG  {store_url} :: {e}", file=sys.stderr)
            time.sleep(self.sleep_seconds)
            if limit and idx >= limit:
                break
        return rows


def load_template_columns(template_path: str | None) -> list[str]:
    if not template_path:
        return DEFAULT_COLUMNS
    df = pd.read_csv(template_path, nrows=0)
    cols = list(df.columns)
    return cols if cols else DEFAULT_COLUMNS


def save_csv(rows: list[dict], output_path: str, columns: list[str]) -> None:
    df = pd.DataFrame(rows)
    for col in columns:
        if col not in df.columns:
            df[col] = pd.NA
    df = df[columns]
    df.to_csv(output_path, index=False, encoding="utf-8-sig")


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape Tokubai Ichikawa store data")
    parser.add_argument("--template", help="Existing CSV to copy column order from")
    parser.add_argument("--output", required=True, help="Output CSV path")
    parser.add_argument("--sleep", type=float, default=0.8, help="Delay between requests")
    parser.add_argument("--timeout", type=int, default=20, help="HTTP timeout in seconds")
    parser.add_argument("--max-pages", type=int, default=100, help="Max city list pages to scan")
    parser.add_argument("--limit", type=int, help="Only scrape the first N stores (for testing)")
    parser.add_argument(
        "--geocode",
        action="store_true",
        help="Geocode addresses via Nominatim (OpenStreetMap)",
    )
    parser.add_argument(
        "--geocode-cache",
        default="geocode_cache.json",
        help="Path to JSON cache for geocoding results",
    )
    args = parser.parse_args()

    columns = load_template_columns(args.template)
    scraper = TokubaiIchikawaScraper(
        sleep_seconds=args.sleep,
        timeout=args.timeout,
        geocode=args.geocode,
        geocode_cache_path=args.geocode_cache if args.geocode else None,
        max_pages=args.max_pages,
    )
    rows = scraper.scrape(limit=args.limit)
    save_csv(rows, args.output, columns)
    print(f"Saved {len(rows)} rows to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
