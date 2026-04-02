/**
 * config.js  ─  データソース切り替え設定
 *
 * DATA_SOURCE を変えるだけでデモ版 ↔ 本番版を切り替えられます。
 *   'json'     : data/stores.json を直接読む（デモ版・現在の設定）
 *   'supabase' : Supabase REST API を使う（Phase 1 以降）
 */
const CONFIG = {

  // ── データソース ──────────────────────────────────────────
  DATA_SOURCE: 'json',          // 'json' | 'supabase'

  // ── JSON モード（デモ版）───────────────────────────────────
  JSON_PATH: './data/stores.json',

  // ── Supabase モード（Phase 1 以降に設定）───────────────────
  SUPABASE_URL:      'https://jmohojrhuxpuoqdfxdjp.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imptb2hvanJodXhwdW9xZGZ4ZGpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNzM4OTksImV4cCI6MjA5MDY0OTg5OX0.T2zL4l1mtMabpRlbIZZYOfnnCCIgP1PitOIeoao0DPA',
  SUPABASE_VIEW: 'latest_store_product_prices',

  // ── 地図デフォルト位置（行徳駅）────────────────────────────
  // 行徳・南行徳エリアを中心に表示
  DEFAULT_LAT:   35.6769,
  DEFAULT_LNG:   139.9197,
  DEFAULT_LABEL: '初期位置: 行徳駅周辺',
  DEFAULT_ZOOM:  14,

  // ── 検索デフォルト ─────────────────────────────────────────
  DEFAULT_KEYWORD: '豆腐',
  DEFAULT_RADIUS:  2,           // 行徳エリアは2kmで主要店舗をカバー
};
