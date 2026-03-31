/**
 * app.js  ─  近所の最安商品マップ
 *
 * データソースは config.js の CONFIG.DATA_SOURCE で切り替えます。
 *   'json'     → data/stores.json をそのまま読む（デモ版）
 *   'supabase' → Supabase REST API 経由で取得（Phase 1 以降）
 */

// ===== グローバル変数 ==============================================
let map, userMarker, radiusCircle;
let storeMarkers = [];
let stores = [];   // JSONモード用キャッシュ

const currentLocation = {
  lat:   CONFIG.DEFAULT_LAT,
  lng:   CONFIG.DEFAULT_LNG,
  label: CONFIG.DEFAULT_LABEL,
};

// ===== DOM 参照 ====================================================
const keywordInput    = document.getElementById('keywordInput');
const categorySelect  = document.getElementById('categorySelect');
const storeTypeSelect = document.getElementById('storeTypeSelect');
const sortSelect      = document.getElementById('sortSelect');
const radiusInput     = document.getElementById('radiusInput');
const searchButton    = document.getElementById('searchButton');
const locationButton  = document.getElementById('locationButton');
const resultsEl       = document.getElementById('results');
const messageEl       = document.getElementById('message');
const locationStatusEl = document.getElementById('locationStatus');
const searchStatusEl   = document.getElementById('searchStatus');
const filterStatusEl   = document.getElementById('filterStatus');
const radiusStatusEl   = document.getElementById('radiusStatus');
const resultCountEl    = document.getElementById('resultCount');
const summaryTextEl    = document.getElementById('summaryText');

// ===== 地図 ========================================================
function initMap() {
  map = L.map('map').setView(
    [currentLocation.lat, currentLocation.lng],
    CONFIG.DEFAULT_ZOOM
  );
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  userMarker = L.marker([currentLocation.lat, currentLocation.lng])
    .addTo(map)
    .bindPopup('現在地');

  radiusCircle = L.circle(
    [currentLocation.lat, currentLocation.lng],
    { radius: Number(radiusInput.value) * 1000, color: '#2e5fa3', fillOpacity: 0.05 }
  ).addTo(map);
}

function updateUserLocation(lat, lng, label) {
  currentLocation.lat   = lat;
  currentLocation.lng   = lng;
  currentLocation.label = label;
  userMarker.setLatLng([lat, lng]);
  radiusCircle.setLatLng([lat, lng]);
  map.setView([lat, lng], CONFIG.DEFAULT_ZOOM);
  locationStatusEl.textContent = label;
}

function clearStoreMarkers() {
  storeMarkers.forEach(m => map.removeLayer(m));
  storeMarkers = [];
}

// ===== ユーティリティ ===============================================
function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s　\-ー_]+/g, '');
}

function isLooseMatch(query, target) {
  const q = normalize(query);
  const t = normalize(target);
  if (!q) return true;
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function formatDate(yyyymmdd) {
  const v = String(yyyymmdd || '');
  if (v.length !== 8) return v || '-';
  return `${v.slice(0,4)}/${v.slice(4,6)}/${v.slice(6,8)}`;
}

// ===== データ取得（データソース抽象化層）============================

/**
 * JSONモード: stores.json を fetch して stores[] に保持
 */
async function loadStoresFromJson() {
  const res = await fetch(CONFIG.JSON_PATH);
  if (!res.ok) throw new Error(`stores.json の読込に失敗しました (${res.status})`);
  stores = await res.json();
}

/**
 * Supabaseモード: REST API で latest_store_product_prices ビューを検索
 * フロントで距離計算するため、Bounding Box 内の全レコードを取得
 */
async function fetchFromSupabase(keyword, category, storeType, radiusKm) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_VIEW } = CONFIG;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('config.js に SUPABASE_URL と SUPABASE_ANON_KEY を設定してください');
  }

  // Bounding Box で絞り込む（Haversine の前段フィルター）
  const deg = radiusKm / 111;
  const params = new URLSearchParams({
    select: '*',
    lat:  `gte.${currentLocation.lat - deg}`,
    // Supabase PostgREST の範囲指定
  });

  // PostgREST フィルター構築
  const headers = {
    apikey:        SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    // 全件取得（ページネーション対策）
    'Range-Unit':  'items',
    'Range':       '0-999',
  };

  // キーワードフィルター（Supabase側でILIKE）
  let url = `${SUPABASE_URL}/rest/v1/${SUPABASE_VIEW}?select=*`;
  if (keyword) url += `&group_name=ilike.*${encodeURIComponent(keyword)}*`;
  if (category) url += `&category=eq.${encodeURIComponent(category)}`;
  if (storeType) url += `&store_type=eq.${encodeURIComponent(storeType)}`;

  // Bounding Box
  url += `&lat=gte.${currentLocation.lat - deg}&lat=lte.${currentLocation.lat + deg}`;
  url += `&lng=gte.${currentLocation.lng - deg}&lng=lte.${currentLocation.lng + deg}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Supabase API エラー (${res.status})`);
  return res.json();
}

/**
 * エントリーポイント: CONFIG.DATA_SOURCE に応じて検索結果を返す
 * 戻り値は共通フォーマット（matches 配列）
 */
async function fetchMatches(keyword, category, storeType, sortBy, radiusKm) {

  if (CONFIG.DATA_SOURCE === 'json') {
    // ── JSONモード ────────────────────────────────────────────────
    // stores はすでにロード済み（loadStoresFromJson で取得）
    const matches = stores.flatMap(store => {
      if (storeType && store.type !== storeType) return [];
      const distanceKm = getDistanceKm(
        currentLocation.lat, currentLocation.lng,
        store.lat, store.lng
      );
      if (distanceKm > radiusKm) return [];

      return store.items
        .filter(item => !category || item.category === category)
        .filter(item => !keyword || isLooseMatch(keyword, item.name))
        .map(item => ({
          storeName:    store.name,
          storeType:    store.type,
          lat:          store.lat,
          lng:          store.lng,
          address:      store.address || '',
          matchedItem:  item.name,
          matchedPrice: item.price,
          category:     item.category     || '',
          subcategory:  item.subcategory  || '',
          lastSeen:     item.last_seen    || '',
          distanceKm,
        }));
    });
    return matches;

  } else if (CONFIG.DATA_SOURCE === 'supabase') {
    // ── Supabaseモード ────────────────────────────────────────────
    const rows = await fetchFromSupabase(keyword, category, storeType, radiusKm);
    return rows
      .map(row => ({
        storeName:    row.store_name,
        storeType:    row.store_type,
        lat:          row.lat,
        lng:          row.lng,
        address:      row.address || '',
        matchedItem:  row.group_name,
        matchedPrice: row.price,
        category:     row.category    || '',
        subcategory:  row.subcategory || '',
        lastSeen:     row.valid_date  || '',
        distanceKm:   getDistanceKm(
          currentLocation.lat, currentLocation.lng,
          row.lat, row.lng
        ),
      }))
      .filter(r => r.distanceKm <= radiusKm);

  } else {
    throw new Error(`未知の DATA_SOURCE: ${CONFIG.DATA_SOURCE}`);
  }
}

// ===== フィルター生成 ===============================================
function populateFilters() {
  if (CONFIG.DATA_SOURCE !== 'json') return; // Supabaseモードは別途実装

  const categories = [...new Set(
    stores.flatMap(s => s.items.map(i => i.category).filter(Boolean))
  )].sort((a, b) => a.localeCompare(b, 'ja'));

  const storeTypes = [...new Set(
    stores.map(s => s.type).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ja'));

  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = cat;
    categorySelect.appendChild(opt);
  });
  storeTypes.forEach(type => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = type;
    storeTypeSelect.appendChild(opt);
  });
}

// ===== メイン検索 ==================================================
async function searchItems() {
  const keyword  = keywordInput.value.trim();
  const category = categorySelect.value;
  const storeType = storeTypeSelect.value;
  const sortBy   = sortSelect.value;
  const radiusKm = Number(radiusInput.value || CONFIG.DEFAULT_RADIUS);

  // ステータスバッジ更新
  searchStatusEl.textContent  = `検索語: ${keyword || '未入力'}`;
  radiusStatusEl.textContent  = `検索半径: ${radiusKm}km`;
  const filterText = [
    category  ? `カテゴリ=${category}`   : null,
    storeType ? `店舗タイプ=${storeType}` : null,
  ].filter(Boolean).join(' / ');
  filterStatusEl.textContent = `絞り込み: ${filterText || 'なし'}`;

  radiusCircle.setRadius(radiusKm * 1000);
  messageEl.textContent = '';
  clearStoreMarkers();

  let matches;
  try {
    matches = await fetchMatches(keyword, category, storeType, sortBy, radiusKm);
  } catch (err) {
    messageEl.textContent = err.message;
    return;
  }

  // ソート
  matches.sort((a, b) => {
    if (sortBy === 'distance') return a.distanceKm - b.distanceKm || a.matchedPrice - b.matchedPrice;
    if (sortBy === 'updated')  return String(b.lastSeen).localeCompare(String(a.lastSeen)) || a.matchedPrice - b.matchedPrice;
    return a.matchedPrice - b.matchedPrice || a.distanceKm - b.distanceKm;
  });

  resultCountEl.textContent = `${matches.length}件`;
  summaryTextEl.textContent = matches.length
    ? `並び順: ${sortSelect.options[sortSelect.selectedIndex].text}`
    : '';

  if (matches.length === 0) {
    resultsEl.innerHTML = '<p class="empty-state">該当する商品が見つかりませんでした。<br>商品名・カテゴリ・半径を変えてみてください。</p>';
    summaryTextEl.textContent = '';
    return;
  }

  const cheapestPrice = Math.min(...matches.map(r => r.matchedPrice));

  // 結果カード描画
  resultsEl.innerHTML = matches.map((row, i) => {
    const isCheapest = row.matchedPrice === cheapestPrice;
    return `
      <article class="result-card ${isCheapest ? 'cheapest' : ''}">
        <div class="result-top">
          <div>
            <div class="result-rank">${i + 1}. ${row.storeName}</div>
            <div class="result-meta">${row.storeType} ・ 約 ${row.distanceKm.toFixed(2)}km</div>
            <div class="result-price">${row.matchedItem} ${row.matchedPrice}円</div>
            <div class="result-sub">
              ${row.category || '-'} / ${row.subcategory || '-'}<br>
              最終確認: ${formatDate(row.lastSeen)}
            </div>
          </div>
          ${isCheapest ? '<span class="cheapest-tag">最安</span>' : ''}
        </div>
      </article>`;
  }).join('');

  // 地図マーカー配置
  matches.forEach(row => {
    const marker = L.marker([row.lat, row.lng]).addTo(map).bindPopup(`
      <strong>${row.storeName}</strong><br>
      ${row.storeType}<br>
      ${row.matchedItem}: ${row.matchedPrice}円<br>
      分類: ${row.category || '-'} / ${row.subcategory || '-'}<br>
      最終確認: ${formatDate(row.lastSeen)}<br>
      現在地から約 ${row.distanceKm.toFixed(2)}km
    `);
    storeMarkers.push(marker);
  });
}

// ===== 現在地取得 ==================================================
function getCurrentLocation() {
  messageEl.textContent = '';
  if (!navigator.geolocation) {
    messageEl.textContent = 'このブラウザでは位置情報が使えません。';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      updateUserLocation(pos.coords.latitude, pos.coords.longitude, '現在地を取得しました');
      searchItems();
    },
    () => {
      messageEl.textContent = '位置情報の取得に失敗しました。ブラウザの許可設定を確認してください。';
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ===== イベント登録 ================================================
searchButton.addEventListener('click', searchItems);
locationButton.addEventListener('click', getCurrentLocation);
keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchItems(); });
categorySelect.addEventListener('change', searchItems);
storeTypeSelect.addEventListener('change', searchItems);
sortSelect.addEventListener('change', searchItems);
radiusInput.addEventListener('change', searchItems);

// ===== 初期化 ======================================================
window.addEventListener('load', async () => {
  try {
    initMap();
    if (CONFIG.DATA_SOURCE === 'json') {
      await loadStoresFromJson();
      populateFilters();
    }
    keywordInput.value = CONFIG.DEFAULT_KEYWORD;
    await searchItems();
  } catch (err) {
    console.error(err);
    messageEl.textContent = err.message || '初期化に失敗しました。';
  }
});
