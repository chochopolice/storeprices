-- ============================================================
-- schema.sql  ─  Supabase SQL Editor に貼り付けて実行する
-- ============================================================
-- 実行手順:
--   1. Supabase ダッシュボード → SQL Editor を開く
--   2. このファイルの内容を貼り付けて「Run」を押す
--   3. エラーがなければセットアップ完了
-- ============================================================

-- pg_trgm 拡張（あいまい検索に使用）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- chains（チェーン）
-- ============================================================
CREATE TABLE IF NOT EXISTS chains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text UNIQUE NOT NULL,   -- URL に使う識別子 例: "aeon", "seiyu"
  logo_url   text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- stores（店舗・支店単位）
-- ============================================================
CREATE TABLE IF NOT EXISTS stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id   uuid REFERENCES chains(id),
  name       text NOT NULL,          -- 例: "イオン 市川妙典店"
  type       text,                   -- "スーパー" | "ドラッグストア" | "ディスカウントストア"
  lat        float NOT NULL,
  lng        float NOT NULL,
  address    text,
  store_code text,                   -- チェーン内の店舗コード（任意）
  created_at timestamptz DEFAULT now()
);

-- 距離検索の前段 Bounding Box フィルター用インデックス
CREATE INDEX IF NOT EXISTS idx_stores_lat_lng ON stores(lat, lng);

-- ============================================================
-- product_groups（検索用の大分類）
-- 例: "豆腐" "牛乳" "卵"
-- ============================================================
CREATE TABLE IF NOT EXISTS product_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,      -- 正規化された商品名 例: "豆腐"
  category       text,               -- 大カテゴリ 例: "食品"
  subcategory    text,               -- サブカテゴリ 例: "大豆製品"
  created_at     timestamptz DEFAULT now()
);

-- ============================================================
-- product_aliases（あいまい検索辞書）
-- "とうふ" "木綿豆腐" "絹豆腐" などを豆腐グループに紐づける
-- ============================================================
CREATE TABLE IF NOT EXISTS product_aliases (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES product_groups(id) ON DELETE CASCADE,
  alias    text NOT NULL,
  source   text DEFAULT 'manual',    -- 'manual' | 'ocr_extracted' | 'user_submitted'
  created_at timestamptz DEFAULT now()
);

-- トライグラム全文検索インデックス（あいまい検索に使用）
CREATE INDEX IF NOT EXISTS idx_aliases_trgm
  ON product_aliases USING gin (alias gin_trgm_ops);

-- ============================================================
-- flyers（チラシ）
-- ============================================================
CREATE TABLE IF NOT EXISTS flyers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid REFERENCES stores(id),
  image_url  text,
  ocr_done   boolean DEFAULT false,
  ocr_text   text,                   -- OCR で得たテキスト全体（デバッグ用）
  valid_from date,
  valid_to   date,
  source_url text,
  fetched_at timestamptz DEFAULT now()
);

-- ============================================================
-- raw_price_observations（OCR・スクレイピングの生データ）
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_price_observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid REFERENCES stores(id),
  flyer_id    uuid REFERENCES flyers(id),
  price       int NOT NULL,
  raw_text    text,                  -- 元のテキスト断片
  source_type text,                  -- 'html_scrape' | 'flyer_ocr' | 'user_receipt' | 'manual_input'
  observed_at date DEFAULT current_date,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- user_receipt_submissions（ユーザー投稿レシート）
-- フロントから投稿された画像＋入力情報を保存
-- ============================================================
CREATE TABLE IF NOT EXISTS user_receipt_submissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_name             text,
  store_address          text,
  product_name           text,
  line_items             jsonb,                  -- 任意: [{ product_name, amount_yen }]
  amount_yen             int CHECK (amount_yen > 0),
  purchased_on           date,
  receipt_image_data_url text NOT NULL,
  note                   text,
  source_type            text NOT NULL DEFAULT 'user_receipt',
  created_at             timestamptz DEFAULT now()
);

-- ============================================================
-- normalized_prices（正規化後の価格）
-- ============================================================
CREATE TABLE IF NOT EXISTS normalized_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid REFERENCES stores(id),
  product_group_id uuid REFERENCES product_groups(id),
  price            int NOT NULL,
  valid_from       date NOT NULL,
  valid_to         date,
  is_sale          boolean DEFAULT false,
  created_at       timestamptz DEFAULT now(),

  -- 同じ店舗・商品グループ・日付の組み合わせは1件のみ
  UNIQUE (store_id, product_group_id, valid_from)
);

-- ============================================================
-- latest_store_product_prices（検索用マテリアライズドビュー）
-- フロントからの検索クエリはこのビューだけに投げる。
-- バッチ完了後に REFRESH する。
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS latest_store_product_prices AS
SELECT DISTINCT ON (np.store_id, np.product_group_id)
  np.store_id,
  np.product_group_id    AS group_id,
  pg.canonical_name      AS group_name,
  pg.category,
  pg.subcategory,
  np.price,
  np.valid_from          AS valid_date,
  np.is_sale,
  s.lat,
  s.lng,
  s.name                 AS store_name,
  s.type                 AS store_type,
  s.address,
  c.name                 AS chain_name
FROM normalized_prices np
JOIN product_groups pg ON pg.id = np.product_group_id
JOIN stores s          ON s.id  = np.store_id
LEFT JOIN chains c     ON c.id  = s.chain_id
WHERE
  -- 30日以内のデータのみ表示（古いデータは除外）
  np.valid_from >= current_date - interval '30 days'
  AND (np.valid_to IS NULL OR np.valid_to >= current_date)
ORDER BY np.store_id, np.product_group_id, np.valid_from DESC;

-- ビューへの検索インデックス
CREATE INDEX IF NOT EXISTS idx_lspp_group_id ON latest_store_product_prices(group_id);
CREATE INDEX IF NOT EXISTS idx_lspp_lat_lng  ON latest_store_product_prices(lat, lng);

-- ============================================================
-- RPC 関数: ビューを更新する（バッチから呼び出す）
-- ============================================================
CREATE OR REPLACE FUNCTION refresh_price_view()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER   -- service_role 権限がなくても実行できる
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY latest_store_product_prices;
END;
$$;

-- ============================================================
-- Row Level Security（RLS）設定
-- anon キーからは SELECT のみ許可する
-- ============================================================
ALTER TABLE chains                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_aliases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_prices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_price_observations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE flyers                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_receipt_submissions   ENABLE ROW LEVEL SECURITY;

-- 読み取りは全員許可
CREATE POLICY "anon read chains"             ON chains                 FOR SELECT USING (true);
CREATE POLICY "anon read stores"             ON stores                 FOR SELECT USING (true);
CREATE POLICY "anon read product_groups"     ON product_groups         FOR SELECT USING (true);
CREATE POLICY "anon read product_aliases"    ON product_aliases        FOR SELECT USING (true);
CREATE POLICY "anon read normalized_prices"  ON normalized_prices      FOR SELECT USING (true);

-- raw データと flyers は書き込み専用（フロントからは読まない）
CREATE POLICY "service only raw"    ON raw_price_observations FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service only flyers" ON flyers                 FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "anon insert receipt submissions" ON user_receipt_submissions
  FOR INSERT
  WITH CHECK (true);
CREATE POLICY "service read receipt submissions" ON user_receipt_submissions
  FOR SELECT
  USING (auth.role() = 'service_role');

-- anon/authenticated からレシート投稿テーブルへ INSERT を許可
GRANT INSERT ON user_receipt_submissions TO anon;
GRANT INSERT ON user_receipt_submissions TO authenticated;

-- マテリアライズドビューへのアクセス（RLS 対象外）
GRANT SELECT ON latest_store_product_prices TO anon;
GRANT SELECT ON latest_store_product_prices TO authenticated;

-- ============================================================
-- シードデータ: product_groups と product_aliases の初期データ
-- ============================================================
INSERT INTO product_groups (id, canonical_name, category, subcategory) VALUES
  ('a0000001-0000-0000-0000-000000000001', '豆腐',       '食品', '大豆製品'),
  ('a0000001-0000-0000-0000-000000000002', '牛乳',       '食品', '乳製品'),
  ('a0000001-0000-0000-0000-000000000003', '卵',         '食品', '卵'),
  ('a0000001-0000-0000-0000-000000000004', 'サラダチキン', '食品', '加工肉'),
  ('a0000001-0000-0000-0000-000000000005', '納豆',       '食品', '大豆製品'),
  ('a0000001-0000-0000-0000-000000000006', '食パン',     '食品', 'パン'),
  ('a0000001-0000-0000-0000-000000000007', 'ヨーグルト', '食品', '乳製品'),
  ('a0000001-0000-0000-0000-000000000008', '豚肉',       '食品', '精肉'),
  ('a0000001-0000-0000-0000-000000000009', '鶏肉',       '食品', '精肉'),
  ('a0000001-0000-0000-0000-000000000010', 'コーラ',     '飲料', '炭酸飲料'),
  ('a0000001-0000-0000-0000-000000000011', '緑茶',       '飲料', 'お茶'),
  ('a0000001-0000-0000-0000-000000000012', 'ティッシュ', '日用品', 'ティッシュ'),
  ('a0000001-0000-0000-0000-000000000013', '洗濯洗剤',   '日用品', '洗剤')
ON CONFLICT DO NOTHING;

INSERT INTO product_aliases (group_id, alias, source) VALUES
  -- 豆腐
  ('a0000001-0000-0000-0000-000000000001', '豆腐',         'manual'),
  ('a0000001-0000-0000-0000-000000000001', 'とうふ',       'manual'),
  ('a0000001-0000-0000-0000-000000000001', 'トウフ',       'manual'),
  ('a0000001-0000-0000-0000-000000000001', '絹豆腐',       'manual'),
  ('a0000001-0000-0000-0000-000000000001', '木綿豆腐',     'manual'),
  ('a0000001-0000-0000-0000-000000000001', '絹ごし豆腐',   'manual'),
  ('a0000001-0000-0000-0000-000000000001', '絹ごし',       'manual'),
  ('a0000001-0000-0000-0000-000000000001', '木綿',         'manual'),
  ('a0000001-0000-0000-0000-000000000001', '充填豆腐',     'manual'),
  -- 牛乳
  ('a0000001-0000-0000-0000-000000000002', '牛乳',         'manual'),
  ('a0000001-0000-0000-0000-000000000002', 'ぎゅうにゅう', 'manual'),
  ('a0000001-0000-0000-0000-000000000002', '低脂肪乳',     'manual'),
  ('a0000001-0000-0000-0000-000000000002', '成分調整牛乳', 'manual'),
  ('a0000001-0000-0000-0000-000000000002', '牛乳1L',       'manual'),
  -- 卵
  ('a0000001-0000-0000-0000-000000000003', '卵',           'manual'),
  ('a0000001-0000-0000-0000-000000000003', 'たまご',       'manual'),
  ('a0000001-0000-0000-0000-000000000003', 'タマゴ',       'manual'),
  ('a0000001-0000-0000-0000-000000000003', '玉子',         'manual'),
  ('a0000001-0000-0000-0000-000000000003', '鶏卵',         'manual'),
  ('a0000001-0000-0000-0000-000000000003', '卵10個',       'manual'),
  -- サラダチキン
  ('a0000001-0000-0000-0000-000000000004', 'サラダチキン', 'manual'),
  ('a0000001-0000-0000-0000-000000000004', 'サラダ鶏',     'manual'),
  -- 納豆
  ('a0000001-0000-0000-0000-000000000005', '納豆',         'manual'),
  ('a0000001-0000-0000-0000-000000000005', 'なっとう',     'manual'),
  ('a0000001-0000-0000-0000-000000000005', '納豆3パック',  'manual'),
  -- 食パン
  ('a0000001-0000-0000-0000-000000000006', '食パン',       'manual'),
  ('a0000001-0000-0000-0000-000000000006', '食パン6枚切',  'manual'),
  ('a0000001-0000-0000-0000-000000000006', '食パン8枚切',  'manual'),
  -- ヨーグルト
  ('a0000001-0000-0000-0000-000000000007', 'ヨーグルト',   'manual'),
  ('a0000001-0000-0000-0000-000000000007', 'よーぐると',   'manual'),
  -- 豚肉
  ('a0000001-0000-0000-0000-000000000008', '豚肉',         'manual'),
  ('a0000001-0000-0000-0000-000000000008', '豚バラ',       'manual'),
  ('a0000001-0000-0000-0000-000000000008', '豚こま',       'manual'),
  ('a0000001-0000-0000-0000-000000000008', 'ぶたにく',     'manual'),
  -- 鶏肉
  ('a0000001-0000-0000-0000-000000000009', '鶏肉',         'manual'),
  ('a0000001-0000-0000-0000-000000000009', '鶏もも',       'manual'),
  ('a0000001-0000-0000-0000-000000000009', '鶏むね',       'manual'),
  ('a0000001-0000-0000-0000-000000000009', 'とりにく',     'manual'),
  -- コーラ
  ('a0000001-0000-0000-0000-000000000010', 'コーラ',       'manual'),
  ('a0000001-0000-0000-0000-000000000010', 'コカコーラ',   'manual'),
  ('a0000001-0000-0000-0000-000000000010', 'Coca-Cola',    'manual'),
  -- 緑茶
  ('a0000001-0000-0000-0000-000000000011', '緑茶',         'manual'),
  ('a0000001-0000-0000-0000-000000000011', 'お茶',         'manual'),
  ('a0000001-0000-0000-0000-000000000011', '伊右衛門',     'manual'),
  ('a0000001-0000-0000-0000-000000000011', '綾鷹',         'manual'),
  -- ティッシュ
  ('a0000001-0000-0000-0000-000000000012', 'ティッシュ',   'manual'),
  ('a0000001-0000-0000-0000-000000000012', 'ティッシュペーパー', 'manual'),
  ('a0000001-0000-0000-0000-000000000012', 'てぃっしゅ',   'manual'),
  -- 洗濯洗剤
  ('a0000001-0000-0000-0000-000000000013', '洗濯洗剤',     'manual'),
  ('a0000001-0000-0000-0000-000000000013', 'アリエール',   'manual'),
  ('a0000001-0000-0000-0000-000000000013', 'ボールド',     'manual'),
  ('a0000001-0000-0000-0000-000000000013', 'アタック',     'manual')
ON CONFLICT DO NOTHING;
