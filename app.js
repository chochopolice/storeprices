// app.js - 近所の最安商品マップ

let map, userMarker, radiusCircle;
let storeMarkers = [];
let stores = [];
let currentLocation = {
  lat:   CONFIG.DEFAULT_LAT,
  lng:   CONFIG.DEFAULT_LNG,
  label: CONFIG.DEFAULT_LABEL || '初期位置',
};

const keywordInput     = document.getElementById('keywordInput');
const categorySelect   = document.getElementById('categorySelect');
const storeTypeSelect  = document.getElementById('storeTypeSelect');
const sortSelect       = document.getElementById('sortSelect');
const radiusInput      = document.getElementById('radiusInput');
const searchButton     = document.getElementById('searchButton');
const locationButton   = document.getElementById('locationButton');
const geocodeButton    = document.getElementById('geocodeButton');
const addressInput     = document.getElementById('addressInput');
const resultsEl        = document.getElementById('results');
const messageEl        = document.getElementById('message');
const locationStatusEl = document.getElementById('locationStatus');
const searchStatusEl   = document.getElementById('searchStatus');
const filterStatusEl   = document.getElementById('filterStatus');
const radiusStatusEl   = document.getElementById('radiusStatus');
const resultCountEl    = document.getElementById('resultCount');
const summaryTextEl    = document.getElementById('summaryText');

function getDistanceKm(lat1,lng1,lat2,lng2){const R=6371;const dLat=(lat2-lat1)*Math.PI/180;const dLng=(lng2-lng1)*Math.PI/180;const a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));return R*c}
function normalize(text){return String(text||"").normalize("NFKC").trim().toLowerCase().replace(/[\s　\-ー_]+/g,"")}
function isLooseMatch(query,target){const q=normalize(query);const t=normalize(target);if(!q)return true;if(t.includes(q))return true;let qi=0;for(let i=0;i<t.length&&qi<q.length;i++){if(t[i]===q[qi])qi++}return qi===q.length}
function formatDate(yyyymmdd){const value=String(yyyymmdd||"");if(value.length!==8)return value||"-";return value.slice(0,4)+"/"+value.slice(4,6)+"/"+value.slice(6,8)}
function initMap(){map=L.map("map").setView([currentLocation.lat,currentLocation.lng],14);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"&copy; OpenStreetMap contributors"}).addTo(map);userMarker=L.marker([currentLocation.lat,currentLocation.lng]).addTo(map).bindPopup("現在地");radiusCircle=L.circle([currentLocation.lat,currentLocation.lng],{radius:Number(radiusInput.value)*1000}).addTo(map)}
function updateUserLocation(lat,lng,labelText){currentLocation={lat,lng,label:labelText};userMarker.setLatLng([lat,lng]);radiusCircle.setLatLng([lat,lng]);map.setView([lat,lng],14);locationStatusEl.textContent=labelText}
function clearStoreMarkers(){storeMarkers.forEach(marker=>map.removeLayer(marker));storeMarkers=[]}
function onCardClick(index) {
  const entry = storeMarkers[index];
  if (!entry) return;

  // 全カードの active クラスをリセット
  document.querySelectorAll('.result-card').forEach(el => el.classList.remove('active'));
  // クリックされたカードをハイライト
  const card = document.querySelector(`.result-card[data-index="${index}"]`);
  if (card) {
    card.classList.add('active');
    // 結果リスト内でスクロールは不要（クリック元なので既に見えている）
  }

  // 地図をその店舗に移動してポップアップを開く
  map.setView([entry.lat, entry.lng], 16, { animate: true });
  entry.marker.openPopup();
}
async function loadStoresFromJson() {
  const res = await fetch(CONFIG.JSON_PATH);
  if (!res.ok) throw new Error(`stores.json の読込に失敗しました (${res.status})`);
  stores = await res.json();
}
async function fetchFromSupabase(keyword, category, subcategory, storeType, radiusKm) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_VIEW } = CONFIG;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('config.js に SUPABASE_URL と SUPABASE_ANON_KEY を設定してください');
  }
  const deg = radiusKm / 111;
  const headers = {
    apikey:        SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Range-Unit':  'items',
    'Range':       '0-999',
  };

  const locationFilter =
    `&lat=gte.${currentLocation.lat - deg}&lat=lte.${currentLocation.lat + deg}` +
    `&lng=gte.${currentLocation.lng - deg}&lng=lte.${currentLocation.lng + deg}`;

  // item_name（生の商品名）で検索し、ヒットしなければ group_name で検索
  // Step1: item_name 検索
  if (keyword) {
    let url1 = `${SUPABASE_URL}/rest/v1/${SUPABASE_VIEW}?select=*`;
    url1 += `&item_name=ilike.*${encodeURIComponent(keyword)}*&item_name=not.is.null`;
    if (category)    url1 += `&category=eq.${encodeURIComponent(category)}`;
    if (subcategory) url1 += `&subcategory=eq.${encodeURIComponent(subcategory)}`;
    if (storeType)   url1 += `&store_type=eq.${encodeURIComponent(storeType)}`;
    url1 += locationFilter;
    const res1 = await fetch(url1, { headers });
    if (res1.ok) {
      const rows1 = await res1.json();
      if (rows1.length > 0) return rows1;
    }
  }

  // Step2: group_name 検索（フォールバック）
  let url = `${SUPABASE_URL}/rest/v1/${SUPABASE_VIEW}?select=*`;
  if (keyword)     url += `&group_name=ilike.*${encodeURIComponent(keyword)}*`;
  if (category)    url += `&category=eq.${encodeURIComponent(category)}`;
  if (subcategory) url += `&subcategory=eq.${encodeURIComponent(subcategory)}`;
  if (storeType)   url += `&store_type=eq.${encodeURIComponent(storeType)}`;
  url += locationFilter;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Supabase API エラー (${res.status})`);
  return res.json();
}
async function searchItems() {
  const keyword      = keywordInput.value.trim();
  const category     = categorySelect.value;
  const subcatEl     = document.getElementById('subcategorySelect');
  const subcategory  = subcatEl ? subcatEl.value : '';
  const storeType    = storeTypeSelect.value;
  const sortBy       = sortSelect.value;
  const radiusKm     = Number(radiusInput.value || CONFIG.DEFAULT_RADIUS || 3);

  searchStatusEl.textContent  = `検索語: ${keyword || '未入力'}`;
  radiusStatusEl.textContent  = `検索半径: ${radiusKm}km`;
  filterStatusEl.textContent  = `絞り込み: ${[
    category    ? `カテゴリ=${category}`        : null,
    subcategory ? `サブカテゴリ=${subcategory}` : null,
    storeType   ? `店舗タイプ=${storeType}`     : null,
  ].filter(Boolean).join(' / ') || 'なし'}`;

  radiusCircle.setRadius(radiusKm * 1000);
  messageEl.textContent = '';
  clearStoreMarkers();

  let matches = [];

  try {
    if (CONFIG.DATA_SOURCE === 'supabase') {
      const rows = await fetchFromSupabase(keyword, category, subcategory, storeType, radiusKm);
      const deg = radiusKm / 111;
      console.log('[si] rows:', rows.length, 'currentLocation:', currentLocation, 'radiusKm:', radiusKm);
      matches = rows
        .filter(row => row.lat && row.lng)
        .map(row => ({
          storeName:    row.store_name,
          storeType:    row.store_type  || '',
          lat:          row.lat,
          lng:          row.lng,
          address:      row.address     || '',
          matchedItem:  row.item_name   || row.group_name,
          matchedPrice: row.price,
          category:     row.category    || '',
          subcategory:  row.subcategory || '',
          lastSeen:     row.valid_date  || '',
          distanceKm:   getDistanceKm(currentLocation.lat, currentLocation.lng, row.lat, row.lng),
        }))
        .filter(r => r.distanceKm <= radiusKm + 0.5);
      console.log('[si] matches after filter:', matches.length);
    } else {
      matches = stores.flatMap(store => {
        if (storeType && store.type !== storeType) return [];
        const distanceKm = getDistanceKm(currentLocation.lat, currentLocation.lng, store.lat, store.lng);
        if (distanceKm > radiusKm) return [];
        return store.items
          .filter(item => !category || item.category === category)
          .filter(item => !keyword  || isLooseMatch(keyword, item.name))
          .map(item => ({
            storeName:    store.name,
            storeType:    store.type,
            lat:          store.lat,
            lng:          store.lng,
            address:      store.address    || '',
            matchedItem:  item.name,
            matchedPrice: item.price,
            category:     item.category    || '',
            subcategory:  item.subcategory || '',
            lastSeen:     item.last_seen   || '',
            distanceKm,
          }));
      });
    }
  } catch(err) {
    messageEl.textContent = err.message;
    return;
  }

  matches.sort((a, b) => {
    if (sortBy === 'distance') return a.distanceKm - b.distanceKm || a.matchedPrice - b.matchedPrice;
    if (sortBy === 'updated')  return String(b.lastSeen).localeCompare(String(a.lastSeen)) || a.matchedPrice - b.matchedPrice;
    return a.matchedPrice - b.matchedPrice || a.distanceKm - b.distanceKm;
  });

  resultCountEl.textContent = `${matches.length}件`;
  summaryTextEl.textContent = matches.length ? `並び順: ${sortSelect.options[sortSelect.selectedIndex].text}` : '';

  if (matches.length === 0) {
    resultsEl.innerHTML = '<p class="empty-state">該当する商品が見つかりませんでした。商品名・カテゴリ・半径を変えてみてください。</p>';
    summaryTextEl.textContent = '';
    return;
  }

  const cheapestPrice = Math.min(...matches.map(r => r.matchedPrice));
  resultsEl.innerHTML = matches.map((row, i) => {
    const isCheapest = row.matchedPrice === cheapestPrice;
    return `<article class="result-card ${isCheapest ? 'cheapest' : ''}" data-index="${i}" title="クリックで地図に移動">
      <div class="result-top"><div>
        <div class="result-rank">${i+1}. ${row.storeName}</div>
        <div class="result-meta">${row.storeType} ・ 約 ${row.distanceKm.toFixed(2)}km</div>
        <div class="result-price">${row.matchedItem} ${row.matchedPrice}円</div>
        <div class="result-sub">${row.category||'-'} / ${row.subcategory||'-'}<br>最終確認: ${formatDate(row.lastSeen)}</div>
      </div>${isCheapest ? '<span class="cheapest-tag">最安</span>' : ''}</div>
    </article>`;
  }).join('');

  resultsEl.onclick = e => {
    const card = e.target.closest('.result-card');
    if (card) onCardClick(Number(card.dataset.index));
  };

  matches.forEach((row, i) => {
    const marker = L.marker([row.lat, row.lng]).addTo(map).bindPopup(
      `<strong>${row.storeName}</strong><br>${row.storeType}<br>` +
      `${row.matchedItem}: <strong>${row.matchedPrice}円</strong><br>` +
      `分類: ${row.category||'-'} / ${row.subcategory||'-'}<br>` +
      `最終確認: ${formatDate(row.lastSeen)}<br>起点から約 ${row.distanceKm.toFixed(2)}km`
    );
    marker.on('click', () => {
      document.querySelectorAll('.result-card').forEach(el => el.classList.remove('active'));
      const card = document.querySelector(`.result-card[data-index="${i}"]`);
      if (card) { card.classList.add('active'); card.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    });
    storeMarkers.push({ marker, lat: row.lat, lng: row.lng });
  });
}
function populateFilters() {
  if (CONFIG.DATA_SOURCE !== 'json') return;
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

  // カテゴリ変更時にサブカテゴリを動的更新
  categorySelect.addEventListener('change', updateSubcategories);
}
async function updateSubcategories() {
  const subcatEl = document.getElementById('subcategorySelect');
  if (!subcatEl) return;
  const cat = categorySelect.value;
  subcatEl.innerHTML = '<option value="">すべて</option>';
  if (!cat || CONFIG.DATA_SOURCE !== 'supabase') return;
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/product_groups?select=canonical_name&category=eq.${encodeURIComponent(cat)}&order=canonical_name`,
      { headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    rows.forEach(r => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = r.canonical_name;
      subcatEl.appendChild(opt);
    });
  } catch(e) { console.warn('サブカテゴリ取得失敗:', e); }
}
function getCurrentLocation(){messageEl.textContent="";if(!navigator.geolocation){messageEl.textContent="このブラウザでは位置情報が使えません。";return}navigator.geolocation.getCurrentPosition(position=>{updateUserLocation(position.coords.latitude,position.coords.longitude,"現在地を取得しました");searchItems()},()=>{messageEl.textContent="位置情報の取得に失敗しました。ブラウザの許可設定を確認してください。"},{enableHighAccuracy:true,timeout:8000})}
async function geocodeAddress() {
  const address = addressInput.value.trim();
  if (!address) {
    messageEl.textContent = '住所・駅名を入力してください。';
    return;
  }

  messageEl.textContent = '住所を検索中...';
  geocodeButton.disabled = true;

  try {
    // Nominatim (OpenStreetMap の無料ジオコーダー・APIキー不要)
    const url = `https://nominatim.openstreetmap.org/search?` +
      new URLSearchParams({
        q:              address,
        format:         'json',
        limit:          '1',
        countrycodes:   'jp',          // 日本に限定
        'accept-language': 'ja',
      });

    const res = await fetch(url, {
      headers: { 'User-Agent': 'PriceCompareMap/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.length) {
      messageEl.textContent = `「${address}」が見つかりませんでした。別の住所や駅名で試してください。`;
      return;
    }

    const { lat, lon, display_name } = data[0];
    const label = display_name.length > 30
      ? display_name.slice(0, 30) + '…'
      : display_name;

    updateUserLocation(Number(lat), Number(lon), label, true);
    messageEl.textContent = '';
    searchItems();

  } catch (err) {
    messageEl.textContent = `住所の検索に失敗しました: ${err.message}`;
  } finally {
    geocodeButton.disabled = false;
  }
}

searchButton.addEventListener('click', searchItems);
locationButton.addEventListener('click', getCurrentLocation);
geocodeButton.addEventListener('click', geocodeAddress);

keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchItems(); });
addressInput.addEventListener('keydown', e => { if (e.key === 'Enter') geocodeAddress(); });

categorySelect.addEventListener('change', () => { updateSubcategories(); searchItems(); });
storeTypeSelect.addEventListener('change', searchItems);
sortSelect.addEventListener('change', searchItems);
radiusInput.addEventListener('change', searchItems);
document.addEventListener('change', e => { if (e.target.id === 'subcategorySelect') searchItems(); });

window.addEventListener('load', async () => {
  try {
    initMap();
    if (CONFIG.DATA_SOURCE === 'json') {
      await loadStoresFromJson();
    }
    await populateFilters();
    if (keywordInput) keywordInput.value = CONFIG.DEFAULT_KEYWORD || '';
    await searchItems();
  } catch(err) {
    console.error(err);
    if (messageEl) messageEl.textContent = err.message || '初期化に失敗しました。';
  }
});
