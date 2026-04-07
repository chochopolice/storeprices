# 近所の最安商品マップ

近くのスーパー・ドラッグストアで、買いたい商品の最安値を地図と一覧で比較できる Web アプリです。

## デモ版（現在の状態）

GitHub Pages で動く静的 Web アプリです。`data/stores.json` がデータソースです。

**動作確認済み機能**
- 商品名のキーワード検索（あいまいマッチ対応）
- カテゴリ・店舗タイプ・検索半径でのフィルタリング
- 価格順・距離順・更新日順のソート
- OpenStreetMap（Leaflet.js）上へのマーカー表示
- ブラウザの位置情報 API による現在地取得

---

## ファイル構成

```
/
├── index.html              # UI（変更不要）
├── style.css               # スタイル
├── config.js               # ★ データソース切り替え設定
├── app.js                  # ロジック（データソース抽象化済み）
├── data/
│   └── stores.json         # デモ用サンプルデータ（8店舗）
├── schema.sql              # Supabase 用 DB スキーマ
├── .github/
│   └── workflows/
│       └── weekly_scrape.yml  # 週次バッチ（GitHub Actions）
└── batch/                  # Python スクレイピングバッチ
    ├── main.py
    ├── requirements.txt
    ├── .env.example        # 環境変数テンプレート
    └── scraper/
        ├── tokubai.py      # HTML スクレイピング
        ├── ocr.py          # Google Vision API OCR
        ├── parser.py       # OCR テキスト解析
        ├── normalizer.py   # 商品名の名寄せ
        └── uploader.py     # Supabase 書き込み
```

---

## セットアップ

### GitHub Pages でデモ版を公開する

1. このリポジトリを自分の GitHub アカウントに fork またはクローン
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`** に設定
3. 数分後に `https://<username>.github.io/<repo>/` で公開される

---

## Phase 1: Supabase に移行する

デモ版が動いたら `config.js` の 1 行を変えるだけで本番切り替えができます。

### 1. Supabase プロジェクト作成

1. [supabase.com](https://supabase.com) で無料アカウントを作成
2. 新しいプロジェクトを作成（リージョン: `Northeast Asia (Tokyo)` 推奨）
3. **SQL Editor** を開き、`schema.sql` の内容を貼り付けて実行

### 2. config.js を更新

```js
// config.js
const CONFIG = {
  DATA_SOURCE:       'supabase',          // ← 'json' から変更
  SUPABASE_URL:      'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...',
  SUPABASE_RECEIPT_TABLE: 'user_receipt_submissions', // レシート投稿の保存先
  // 他はそのまま
};
```

### 3. GitHub Secrets を設定

バッチが Supabase に書き込むために必要です。

**Settings → Secrets and variables → Actions → New repository secret** で以下を追加：

| Secret 名 | 値 |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase の `service_role` キー |
| `GOOGLE_VISION_KEY` | Google Cloud Vision API キー（OCR 使用時のみ） |

---

## バッチのローカルテスト

```bash
cd batch

# 環境変数ファイルを作成
cp .env.example .env
# .env を編集して SUPABASE_URL などを設定

# 依存パッケージをインストール
pip install -r requirements.txt

# Supabase なしでドライランテスト（パーサーと正規化だけ確認）
python main.py

# Supabase あり・OCR なしでテスト
ENABLE_OCR=false python main.py

# OCR を 1 枚だけテスト（Google Vision API キーが必要）
ENABLE_OCR=true MAX_OCR_PER_RUN=1 python main.py
```

---

## トクバイのセレクタ設定

`batch/scraper/tokubai.py` の `STORE_MAPPING` と HTML セレクタを実際の店舗に合わせて設定してください。

```python
# tokubai.py の STORE_MAPPING に追加
STORE_MAPPING = [
    {
        "tokubai_id":  "12345",          # トクバイの店舗 ID（URL から確認）
        "supabase_id": "uuid-ここに入れる",  # Supabase stores テーブルの id
        "name":        "○○スーパー ××店",
    },
]
```

トクバイの店舗 ID は `https://tokubai.co.jp/stores/{id}` の URL で確認できます。

> **注意**: スクレイピング前に必ず `robots.txt` と利用規約を確認してください。

---

## データ更新（手動）

GitHub Actions タブ → **Weekly Price Scrape** → **Run workflow** で手動実行できます。

```
Actions タブ → Weekly Price Scrape → Run workflow ボタン
  ├── OCRを実行する: false（デフォルト）
  └── 最大OCR枚数: 10
```

---

## コスト目安

| サービス | 無料枠 | 目安使用量 |
|---|---|---|
| GitHub Pages | 無制限 | — |
| GitHub Actions | 月 2,000 分 | 週 1 回 × 約 5 分 = 月 20 分 |
| Supabase Free | 行数 50 万・帯域 5GB/月 | 十分 |
| Google Vision API | 月 1,000 枚 | 週 1 回 × 14 店舗 = 月 56 枚 |

**月額 0 円で運用できます。**
