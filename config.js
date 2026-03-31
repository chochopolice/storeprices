/**
 * config.js  ─  データソース切り替え設定
 *
 * DATA_SOURCE を変えるだけでデモ版 ↔ 本番版を切り替えられます。
 *
 *   'json'     : data/stores.json を直接読む（デモ版・現在の設定）
 *   'supabase' : Supabase REST API を使う（Phase 1 以降）
 */
const CONFIG = {

  // ── データソース ──────────────────────────────────────────
  DATA_SOURCE: 'json',          // 'json' | 'supabase'

  // ── JSON モード（デモ版）───────────────────────────────────
  JSON_PATH: './data/stores.json',

  // ── Supabase モード（Phase 1 以降に設定）───────────────────
  // GitHub Pages は静的ファイルなのでキーは anon（公開可）のみ使用
  SUPABASE_URL:      '',        // 例: 'https://xxxx.supabase.co'
  SUPABASE_ANON_KEY: '',        // Supabase ダッシュボード > Settings > API

  // 検索APIのエンドポイント（Supabase の View 名と合わせる）
  SUPABASE_VIEW: 'latest_store_product_prices',

  // ── 地図デフォルト位置（東京駅）────────────────────────────
  DEFAULT_LAT:   35.681236,
  DEFAULT_LNG:   139.767125,
  DEFAULT_LABEL: '初期位置: 東京駅周辺',
  DEFAULT_ZOOM:  14,

  // ── 検索デフォルト ─────────────────────────────────────────
  DEFAULT_KEYWORD: '豆腐',
  DEFAULT_RADIUS:  3,           // km
};
