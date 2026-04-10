const CONFIG = {

  // ── データソース ──────────────────────────────────────────
  DATA_SOURCE: 'supabase',      // 'json' | 'supabase'

  // ── JSON モード（デモ版）───────────────────────────────────
  JSON_PATH: './data/stores.json',

  // ── Supabase ───────────────────────────────────────────────
  SUPABASE_URL:      'https://jmohojrhuxpuoqdfxdjp.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imptb2hvanJodXhwdW9xZGZ4ZGpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNzM4OTksImV4cCI6MjA5MDY0OTg5OX0.T2zL4l1mtMabpRlbIZZYOfnnCCIgP1PitOIeoao0DPA',
  SUPABASE_VIEW:          'latest_store_product_prices',
  SUPABASE_RECEIPT_TABLE: 'user_receipt_submissions',
  SUPABASE_EDGE_OCR_URL:  'https://jmohojrhuxpuoqdfxdjp.supabase.co/functions/v1/ocr-receipt',

  // ── 地図デフォルト位置（行徳駅）────────────────────────────
  DEFAULT_LAT:   35.6769,
  DEFAULT_LNG:   139.9197,
  DEFAULT_LABEL: '初期位置: 行徳駅周辺',
  DEFAULT_ZOOM:  14,

  // ── 検索デフォルト ─────────────────────────────────────────
  DEFAULT_KEYWORD: '豆腐',
  DEFAULT_RADIUS:  2,
};
