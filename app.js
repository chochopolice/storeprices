/**
 * app.js  ─  近所の最安商品マップ
 *
 * 改善内容:
 *   1. 現在地アイコンを専用のパルスアイコンに変更（店舗マーカーと区別）
 *   2. 結果カードクリックで地図がその店舗に移動しポップアップを開く
 *   3. 住所・駅名の入力 or 地図クリックで起点を自由に指定できる
 */

// ===== グローバル変数 ==============================================
let map, userMarker, radiusCircle;
let storeMarkers = [];   // { marker, lat, lng } の配列（カードと同順）
let stores = [];

const currentLocation = {
  lat:   CONFIG.DEFAULT_LAT,
  lng:   CONFIG.DEFAULT_LNG,
  label: CONFIG.DEFAULT_LABEL,
};

// ===== DOM 参照 ====================================================
const keywordInput     = document.getElementById('keywordInput');
const categorySelect   = document.getElementById('categorySelect');
const storeTypeSelect  = document.getElementById('storeTypeSelect');
const sortSelect       = document.getElementById('sortSelect');
const radiusInput      = document.getElementById('radiusInput');
const searchButton     = document.getElementById('searchButton');
const locationButton   = document.getElementById('locationButton');
const addressInput     = document.getElementById('addressInput');
const geocodeButton    = document.getElementById('geocodeButton');
const resultsEl        = document.getElementById('results');
const messageEl        = document.getElementById('message');
const locationStatusEl = document.getElementById('locationStatus');
const searchStatusEl   = document.getElementById('searchStatus');
const filterStatusEl   = document.getElementById('filterStatus');
const radiusStatusEl   = document.getElementById('radiusStatus');
const resultCountEl    = document.getElementById('resultCount');
const summaryTextEl    = document.getElementById('summaryText');
const receiptFormEl    = document.getElementById('receiptForm');
const receiptImageInputEl = document.getElementById('receiptImageInput');
const receiptStoreNameInputEl = document.getElementById('receiptStoreNameInput');
const receiptStoreAddressInputEl = document.getElementById('receiptStoreAddressInput');
const receiptProductNameInputEl = document.getElementById('receiptProductNameInput');
const receiptPriceInputEl = document.getElementById('receiptPriceInput');
const receiptPurchasedAtInputEl = document.getElementById('receiptPurchasedAtInput');
const receiptNoteInputEl = document.getElementById('receiptNoteInput');
const receiptMatchButtonEl = document.getElementById('receiptMatchButton');
const receiptMatchResultEl = document.getElementById('receiptMatchResult');
const receiptMatchActionsEl = document.getElementById('receiptMatchActions');
const receiptPriceOkButtonEl = document.getElementById('receiptPriceOkButton');
const receiptPriceEditButtonEl = document.getElementById('receiptPriceEditButton');
const receiptSubmitButtonEl = document.getElementById('receiptSubmitButton');
const receiptMessageEl = document.getElementById('receiptMessage');
let receiptPriceConfirmed = false;
const RECEIPT_DRAFT_STORAGE_KEY = 'receipt_form_draft_v1';
let currentReceiptFileKey = '';

// ===== 【機能1】カスタムアイコン定義 ================================

/** 現在地・起点アイコン: 青いパルス円（店舗ピンと明確に区別） */
const userLocationIcon = L.divIcon({
  className: '',           // Leaflet デフォルトスタイルをリセット
  html: '<div class="user-location-icon"></div>',
  iconSize:   [22, 22],
  iconAnchor: [11, 11],   // 円の中心をピン位置に合わせる
  popupAnchor:[0, -14],
});

/** 地図クリック・住所指定時の起点アイコン: オレンジ円 */
const customPointIcon = L.divIcon({
  className: '',
  html: '<div class="custom-point-icon"></div>',
  iconSize:   [20, 20],
  iconAnchor: [10, 10],
  popupAnchor:[0, -13],
});

// ===== 地図初期化 ==================================================
function initMap() {
  map = L.map('map').setView(
    [currentLocation.lat, currentLocation.lng],
    CONFIG.DEFAULT_ZOOM
  );
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // 現在地マーカー（カスタムアイコン使用）
  userMarker = L.marker(
    [currentLocation.lat, currentLocation.lng],
    { icon: userLocationIcon, zIndexOffset: 1000 }   // 店舗マーカーより手前
  ).addTo(map).bindPopup('起点');

  radiusCircle = L.circle(
    [currentLocation.lat, currentLocation.lng],
    { radius: Number(radiusInput.value) * 1000, color: '#2e5fa3', fillOpacity: 0.05 }
  ).addTo(map);

  // 【機能3】地図クリックで起点を設定
  map.on('click', onMapClick);
}

function updateUserLocation(lat, lng, label, useCustomIcon = false) {
  currentLocation.lat   = lat;
  currentLocation.lng   = lng;
  currentLocation.label = label;
  // 現在地取得 → 青パルス、住所・地図クリック → オレンジ
  userMarker.setIcon(useCustomIcon ? customPointIcon : userLocationIcon);
  userMarker.setLatLng([lat, lng]);
  userMarker.setPopupContent(label);
  radiusCircle.setLatLng([lat, lng]);
  map.setView([lat, lng], CONFIG.DEFAULT_ZOOM);
  locationStatusEl.textContent = label;
}

function clearStoreMarkers() {
  storeMarkers.forEach(({ marker }) => map.removeLayer(marker));
  storeMarkers = [];
}

// ===== 逆ジオコーディング（緯度経度 → 住所） ========================
async function reverseGeocodeLatLng(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?` +
    new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: 'jsonv2',
      zoom: '18',
      'accept-language': 'ja',
    });

  const res = await fetch(url, {
    headers: { 'User-Agent': 'PriceCompareMap/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  return data?.display_name || '';
}

// ===== 【機能3】地図クリックで起点設定 ==============================
async function onMapClick(e) {
  const { lat, lng } = e.latlng;
  const fallbackLabel = `地図で指定した地点 (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

  messageEl.textContent = '地点の住所を取得中...';
  try {
    const address = await reverseGeocodeLatLng(lat, lng);
    const label = address
      ? `地図で指定: ${address}`
      : fallbackLabel;
    updateUserLocation(lat, lng, label, true);
    addressInput.value = address || '';
    messageEl.textContent = '';
  } catch (err) {
    updateUserLocation(lat, lng, fallbackLabel, true);
    addressInput.value = '';
    messageEl.textContent = `住所の取得に失敗したため座標で設定しました: ${err.message}`;
  }
  searchItems();
}

// ===== 【機能3】住所ジオコーディング（Nominatim） ===================
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

function getTokenSet(text) {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9ぁ-んァ-ヶー一-龠]+/i)
      .filter(Boolean)
  );
}

function getTokenSimilarity(a, b) {
  const setA = getTokenSet(a);
  const setB = getTokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach(token => {
    if (setB.has(token)) intersection += 1;
  });
  return intersection / Math.max(setA.size, setB.size);
}

function formatDate(yyyymmdd) {
  const v = String(yyyymmdd || '');
  if (v.length !== 8) return v || '-';
  return `${v.slice(0,4)}/${v.slice(4,6)}/${v.slice(6,8)}`;
}

function setReceiptMessage(text, type = 'error') {
  if (!receiptMessageEl) return;
  receiptMessageEl.textContent = text;
  receiptMessageEl.classList.remove('error', 'success');
  if (type) receiptMessageEl.classList.add(type);
}

function setMatchResult(text, type = 'neutral') {
  if (!receiptMatchResultEl) return;
  receiptMatchResultEl.textContent = text;
  receiptMatchResultEl.classList.remove('success', 'error');
  if (type === 'success' || type === 'error') {
    receiptMatchResultEl.classList.add(type);
  }
}

function resetMatchingState() {
  receiptPriceConfirmed = false;
  if (receiptPriceInputEl) receiptPriceInputEl.readOnly = true;
  if (receiptMatchActionsEl) receiptMatchActionsEl.classList.add('hidden');
  setMatchResult('');
}

function getReceiptFileKey(file) {
  if (!file) return '';
  return [file.name || '', file.size || 0, file.lastModified || 0].join('::');
}

function loadReceiptDraftMap() {
  try {
    const raw = localStorage.getItem(RECEIPT_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveReceiptDraftMap(map) {
  try {
    localStorage.setItem(RECEIPT_DRAFT_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {
    // 端末容量やプライベートモード時は保存失敗しうるため握りつぶす
  }
}

function getCurrentReceiptDraft() {
  return {
    store_name: receiptStoreNameInputEl?.value.trim() || '',
    store_address: receiptStoreAddressInputEl?.value.trim() || '',
    product_name: receiptProductNameInputEl?.value.trim() || '',
    amount_yen: receiptPriceInputEl?.value.trim() || '',
    purchased_on: toIsoDateString(receiptPurchasedAtInputEl?.value) || '',
  };
}

function applyReceiptDraftToForm(draft) {
  if (!draft) return;
  if (receiptStoreNameInputEl && draft.store_name && !receiptStoreNameInputEl.value.trim()) {
    receiptStoreNameInputEl.value = draft.store_name;
  }
  if (receiptStoreAddressInputEl && draft.store_address && !receiptStoreAddressInputEl.value.trim()) {
    receiptStoreAddressInputEl.value = draft.store_address;
  }
  if (receiptProductNameInputEl && draft.product_name && !receiptProductNameInputEl.value.trim()) {
    receiptProductNameInputEl.value = draft.product_name;
  }
  if (receiptPriceInputEl && draft.amount_yen && !receiptPriceInputEl.value.trim()) {
    receiptPriceInputEl.value = String(draft.amount_yen);
  }
  if (receiptPurchasedAtInputEl && draft.purchased_on && !receiptPurchasedAtInputEl.value) {
    receiptPurchasedAtInputEl.value = draft.purchased_on;
  }
}

function persistReceiptDraft({ includeGlobal = false } = {}) {
  const draftMap = loadReceiptDraftMap();
  const currentDraft = getCurrentReceiptDraft();
  if (currentReceiptFileKey) {
    draftMap[currentReceiptFileKey] = currentDraft;
  }
  if (includeGlobal) {
    draftMap.__latest = currentDraft;
  }
  saveReceiptDraftMap(draftMap);
}

function restoreDraftForSelectedFile() {
  const selectedFile = receiptImageInputEl?.files?.[0];
  currentReceiptFileKey = getReceiptFileKey(selectedFile);
  const draftMap = loadReceiptDraftMap();
  const matched = (currentReceiptFileKey && draftMap[currentReceiptFileKey]) || draftMap.__latest;
  applyReceiptDraftToForm(matched);
}

function toIsoDateString(dateValue) {
  const v = String(dateValue || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return '';
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('画像の読み取りに失敗しました。'));
    reader.readAsDataURL(file);
  });
}

async function postReceiptPayload(payload) {
  const preferredTable = String(CONFIG.SUPABASE_RECEIPT_TABLE || 'user_receipt_submissions').trim();
  const candidateTables = [
    preferredTable,
    'user_receipt_submissions',
    'receipt_submissions',
    'user_receipts',
  ].filter((table, index, arr) => table && arr.indexOf(table) === index);

  let lastError = null;
  for (const table of candidateTables) {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return { table };

    const errorText = await res.text().catch(() => '');
    lastError = new Error(`DB書き込みに失敗しました (HTTP ${res.status})`);
    lastError.status = res.status;
    lastError.table = table;
    lastError.detail = errorText;
    if (res.status !== 404) {
      throw lastError;
    }
  }
  throw lastError || new Error('DB書き込みに失敗しました。');
}

async function submitReceipt(e) {
  e.preventDefault();
  if (!receiptFormEl) return;

  const imageFile = receiptImageInputEl.files?.[0];
  const storeName = receiptStoreNameInputEl.value.trim();
  const storeAddress = receiptStoreAddressInputEl.value.trim();
  const productName = receiptProductNameInputEl.value.trim();
  const priceRaw = receiptPriceInputEl.value.trim();
  const price = priceRaw ? Number(priceRaw) : null;
  const purchasedAt = toIsoDateString(receiptPurchasedAtInputEl.value);
  const note = receiptNoteInputEl.value.trim();

  if (!imageFile) {
    setReceiptMessage('レシート画像を選択してください。', 'error');
    return;
  }
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    setReceiptMessage('Supabase接続情報が未設定です。config.js を確認してください。', 'error');
    return;
  }
  if (imageFile.size > 3 * 1024 * 1024) {
    setReceiptMessage('画像サイズは3MB以下にしてください。', 'error');
    return;
  }

  try {
    setReceiptMessage('投稿中です...', null);
    receiptSubmitButtonEl.disabled = true;

    const imageDataUrl = await fileToDataUrl(imageFile);
    const payload = {
      store_name: storeName || null,
      store_address: storeAddress || null,
      product_name: productName || null,
      amount_yen: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
      purchased_on: purchasedAt || null,
      receipt_image_data_url: imageDataUrl,
      note: note || null,
      source_type: 'user_receipt',
    };

    await postReceiptPayload(payload);

    receiptFormEl.reset();
    currentReceiptFileKey = '';
    resetMatchingState();
    setReceiptMessage('投稿ありがとうございました。DBに保存しました。', 'success');
    persistReceiptDraft({ includeGlobal: false });
  } catch (err) {
    if (err?.status === 404) {
      setReceiptMessage(
        'DB書き込み先が見つかりません。schema.sql を実行し、config.js の SUPABASE_RECEIPT_TABLE を確認してください。',
        'error'
      );
      return;
    }
    if (err?.status === 401 || err?.status === 403) {
      setReceiptMessage('DBへの書き込み権限がありません。schema.sql の GRANT/POLICY 設定を反映してください。', 'error');
      return;
    }
    setReceiptMessage(err.message || '投稿に失敗しました。', 'error');
  } finally {
    receiptSubmitButtonEl.disabled = false;
  }
}

async function findClosestPriceCandidate(storeName, productName) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_VIEW } = CONFIG;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
  const params = new URLSearchParams({ select: 'store_name,group_name,price,valid_date' });
  params.append('store_name', `ilike.*${storeName}*`);
  params.append('group_name', `ilike.*${productName}*`);
  params.append('order', 'valid_date.desc');
  params.append('limit', '20');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_VIEW}?${params.toString()}`, { headers });
  if (!res.ok) throw new Error(`照合APIエラー (HTTP ${res.status})`);
  const rows = await res.json();
  if (!rows.length) return null;

  const scored = rows
    .map(row => {
      const storeScore = getTokenSimilarity(storeName, row.store_name);
      const productScore = getTokenSimilarity(productName, row.group_name);
      const totalScore = storeScore * 0.45 + productScore * 0.55;
      return { ...row, totalScore };
    })
    .sort((a, b) => b.totalScore - a.totalScore || String(b.valid_date).localeCompare(String(a.valid_date)));
  return scored[0];
}

function buildMissingFieldList() {
  const missing = [];
  if (!receiptStoreNameInputEl.value.trim()) missing.push('店舗名');
  if (!receiptStoreAddressInputEl.value.trim()) missing.push('店舗住所');
  if (!receiptProductNameInputEl.value.trim()) missing.push('商品名');
  if (!receiptPriceInputEl.value.trim()) missing.push('金額');
  if (!toIsoDateString(receiptPurchasedAtInputEl.value)) missing.push('購入日');
  return missing;
}

async function matchReceiptPriceWithDb() {
  const imageFile = receiptImageInputEl.files?.[0];
  const storeName = receiptStoreNameInputEl.value.trim();
  const productName = receiptProductNameInputEl.value.trim();

  if (!imageFile) {
    setMatchResult('先にレシート画像を選択してください。', 'error');
    return;
  }
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    setMatchResult('Supabase接続情報が未設定です。config.js を確認してください。', 'error');
    return;
  }

  receiptMatchButtonEl.disabled = true;
  setMatchResult('DB照合中です...');
  receiptPriceConfirmed = false;
  receiptPriceInputEl.readOnly = true;
  receiptMatchActionsEl.classList.add('hidden');
  setReceiptMessage('', null);

  try {
    let dbAddressCandidate = null;
    if (storeName) {
      const params = new URLSearchParams({ select: 'store_name,address,valid_date' });
      params.append('store_name', `ilike.*${storeName}*`);
      params.append('order', 'valid_date.desc');
      params.append('limit', '1');
      const addressRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_VIEW}?${params.toString()}`, {
        headers: {
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        },
      });
      if (addressRes.ok) {
        const rows = await addressRes.json();
        dbAddressCandidate = rows?.[0] || null;
      }
    }

    if (dbAddressCandidate?.address && !receiptStoreAddressInputEl.value.trim()) {
      receiptStoreAddressInputEl.value = dbAddressCandidate.address;
    }

    if (!storeName || !productName) {
      const missing = buildMissingFieldList();
      setMatchResult(`DB補完を一部適用しました。未入力: ${missing.join('・') || 'なし'}`, missing.length ? 'error' : 'success');
      return;
    }

    const best = await findClosestPriceCandidate(storeName, productName);
    if (!best) {
      receiptPriceInputEl.value = '';
      const missing = buildMissingFieldList();
      setMatchResult(`DB上に近い商品が見つかりませんでした。未入力: ${missing.join('・') || 'なし'}`, 'error');
      receiptMatchActionsEl.classList.remove('hidden');
      return;
    }
    receiptPriceInputEl.value = best.price;
    const missing = buildMissingFieldList();
    setMatchResult(`候補: ${best.store_name} / ${best.group_name} / ${best.price}円（${formatDate(String(best.valid_date).replaceAll('-', ''))}時点） / 未入力: ${missing.join('・') || 'なし'}`, missing.length ? 'error' : 'success');
    receiptMatchActionsEl.classList.remove('hidden');
    persistReceiptDraft({ includeGlobal: true });
  } catch (err) {
    setMatchResult(err.message || '照合に失敗しました。', 'error');
  } finally {
    receiptMatchButtonEl.disabled = false;
  }
}

function confirmMatchedPrice() {
  if (!receiptPriceInputEl.value) {
    setReceiptMessage('金額が未入力です。照合を実行するか、修正して入力してください。', 'error');
    return;
  }
  receiptPriceInputEl.readOnly = true;
  receiptPriceConfirmed = true;
  setReceiptMessage('金額を確定しました。投稿できます。', 'success');
}

function enableManualPriceEdit() {
  receiptPriceInputEl.readOnly = false;
  receiptPriceInputEl.focus();
  receiptPriceConfirmed = true;
  setReceiptMessage('金額を修正してください。修正後はそのまま投稿できます。', 'success');
}

// ===== データ取得（データソース抽象化層）============================
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

async function fetchMatches(keyword, category, storeType, sortBy, radiusKm) {
  if (CONFIG.DATA_SOURCE === 'json') {
    return stores.flatMap(store => {
      if (storeType && store.type !== storeType) return [];
      const distanceKm = getDistanceKm(
        currentLocation.lat, currentLocation.lng, store.lat, store.lng
      );
      if (distanceKm > radiusKm) return [];
      return store.items
        .filter(item => !category || item.category === category)
        .filter(item => !keyword   || isLooseMatch(keyword, item.name))
        .map(item => ({
          storeName:    store.name,
          storeType:    store.type,
          lat:          store.lat,
          lng:          store.lng,
          address:      store.address   || '',
          matchedItem:  item.name,
          matchedPrice: item.price,
          category:     item.category   || '',
          subcategory:  item.subcategory || '',
          lastSeen:     item.last_seen  || '',
          distanceKm,
        }));
    });
  } else if (CONFIG.DATA_SOURCE === 'supabase') {
    const rows = await fetchFromSupabase(keyword, category, document.getElementById("subcategorySelect")?.value || "", storeType, radiusKm);
    return rows.map(row => {
      const distanceKm = (row.lat && row.lng)
        ? getDistanceKm(currentLocation.lat, currentLocation.lng, row.lat, row.lng)
        : 0;
      return {
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
        distanceKm,
      };
    }).filter(r => r.distanceKm <= radiusKm * 1.5); // bounding boxに任せつつ少し余裕を持たせる
  } else {
    throw new Error(`未知の DATA_SOURCE: ${CONFIG.DATA_SOURCE}`);
  }
}

// ===== フィルター生成 ===============================================
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
  const subcategorySelect = document.getElementById('subcategorySelect');
  if (!subcategorySelect) return;
  const cat = categorySelect.value;
  subcategorySelect.innerHTML = '<option value="">すべて</option>';
  if (!cat || CONFIG.DATA_SOURCE !== 'supabase') return;
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/product_groups?select=subcategory&category=eq.${encodeURIComponent(cat)}&order=subcategory`,
      { headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const subs = [...new Set(rows.map(r => r.subcategory).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja'));
    subs.forEach(sub => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = sub;
      subcategorySelect.appendChild(opt);
    });
  } catch(e) { console.warn('サブカテゴリ取得失敗:', e); }
}

// ===== 【機能2】カードクリックで地図移動 ============================
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

// ===== メイン検索 ==================================================
async function searchItems() {
  const keyword   = keywordInput.value.trim();
  const category  = categorySelect.value;
  const storeType = storeTypeSelect.value;
  const sortBy    = sortSelect.value;
  const radiusKm  = Number(radiusInput.value || CONFIG.DEFAULT_RADIUS);

  searchStatusEl.textContent = `検索語: ${keyword || '未入力'}`;
  radiusStatusEl.textContent = `検索半径: ${radiusKm}km`;
  const filterText = [
    category  ? `カテゴリ=${category}`    : null,
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

  // 結果カード描画（data-index を付与してカードとマーカーを紐づける）
  resultsEl.innerHTML = matches.map((row, i) => {
    const isCheapest = row.matchedPrice === cheapestPrice;
    return `
      <article class="result-card ${isCheapest ? 'cheapest' : ''}"
               data-index="${i}"
               title="クリックで地図に移動">
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

  // カードクリックイベントを委譲で登録
  resultsEl.onclick = e => {
    const card = e.target.closest('.result-card');
    if (card) onCardClick(Number(card.dataset.index));
  };

  // 地図マーカーを matches と同じ順序で配置（storeMarkers[i] = matches[i] に対応）
  matches.forEach((row, i) => {
    const marker = L.marker([row.lat, row.lng]).addTo(map).bindPopup(`
      <strong>${row.storeName}</strong><br>
      ${row.storeType}<br>
      ${row.matchedItem}: <strong>${row.matchedPrice}円</strong><br>
      分類: ${row.category || '-'} / ${row.subcategory || '-'}<br>
      最終確認: ${formatDate(row.lastSeen)}<br>
      起点から約 ${row.distanceKm.toFixed(2)}km
    `);

    // マーカークリック → 対応するカードもハイライト
    marker.on('click', () => {
      document.querySelectorAll('.result-card').forEach(el => el.classList.remove('active'));
      const card = document.querySelector(`.result-card[data-index="${i}"]`);
      if (card) {
        card.classList.add('active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });

    storeMarkers.push({ marker, lat: row.lat, lng: row.lng });
  });
}

// ===== 現在地取得 ==================================================
function getCurrentLocation() {
  messageEl.textContent = '';
  if (!navigator.geolocation) {
    messageEl.textContent = 'このブラウザでは位置情報が使えません。';
    return;
  }
  locationButton.disabled = true;
  locationButton.textContent = '取得中...';
  navigator.geolocation.getCurrentPosition(
    pos => {
      updateUserLocation(
        pos.coords.latitude, pos.coords.longitude,
        '現在地を取得しました', false    // 青パルスアイコン
      );
      addressInput.value = '';
      searchItems();
      locationButton.disabled = false;
      locationButton.textContent = '現在地取得';
    },
    () => {
      messageEl.textContent = '位置情報の取得に失敗しました。ブラウザの許可設定を確認してください。';
      locationButton.disabled = false;
      locationButton.textContent = '現在地取得';
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ===== イベント登録 ================================================
searchButton.addEventListener('click', searchItems);
locationButton.addEventListener('click', getCurrentLocation);
geocodeButton.addEventListener('click', geocodeAddress);

keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchItems(); });
addressInput.addEventListener('keydown', e => { if (e.key === 'Enter') geocodeAddress(); });

categorySelect.addEventListener('change',  searchItems);
storeTypeSelect.addEventListener('change', searchItems);
document.addEventListener('change', e => { if (e.target.id === 'subcategorySelect') searchItems(); });
sortSelect.addEventListener('change',      searchItems);
radiusInput.addEventListener('change',     searchItems);
if (receiptFormEl) receiptFormEl.addEventListener('submit', submitReceipt);
if (receiptMatchButtonEl) receiptMatchButtonEl.addEventListener('click', matchReceiptPriceWithDb);
if (receiptPriceOkButtonEl) receiptPriceOkButtonEl.addEventListener('click', confirmMatchedPrice);
if (receiptPriceEditButtonEl) receiptPriceEditButtonEl.addEventListener('click', enableManualPriceEdit);
if (receiptImageInputEl) {
  receiptImageInputEl.addEventListener('change', () => {
    resetMatchingState();
    restoreDraftForSelectedFile();
  });
}
if (receiptStoreNameInputEl) {
  receiptStoreNameInputEl.addEventListener('input', () => {
    resetMatchingState();
    persistReceiptDraft({ includeGlobal: true });
  });
}
if (receiptStoreAddressInputEl) receiptStoreAddressInputEl.addEventListener('input', () => persistReceiptDraft({ includeGlobal: true }));
if (receiptProductNameInputEl) {
  receiptProductNameInputEl.addEventListener('input', () => {
    resetMatchingState();
    persistReceiptDraft({ includeGlobal: true });
  });
}
if (receiptPriceInputEl) receiptPriceInputEl.addEventListener('input', () => persistReceiptDraft({ includeGlobal: true }));
if (receiptPurchasedAtInputEl) receiptPurchasedAtInputEl.addEventListener('change', () => persistReceiptDraft({ includeGlobal: true }));

// ===== 初期化 ======================================================
window.addEventListener('load', async () => {
  try {
    initMap();
    applyReceiptDraftToForm(loadReceiptDraftMap().__latest);
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
