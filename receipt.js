const receiptFormEl = document.getElementById('receiptForm');
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

const RECEIPT_DRAFT_STORAGE_KEY = 'receipt_form_draft_v1';
let currentReceiptFileKey = '';

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000\-ー_]+/g, '');
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
  return `${v.slice(0, 4)}/${v.slice(4, 6)}/${v.slice(6, 8)}`;
}

function setReceiptMessage(text, type = 'error') {
  receiptMessageEl.textContent = text;
  receiptMessageEl.classList.remove('error', 'success');
  if (type) receiptMessageEl.classList.add(type);
}

function setMatchResult(text, type = 'neutral') {
  receiptMatchResultEl.textContent = text;
  receiptMatchResultEl.classList.remove('success', 'error');
  if (type === 'success' || type === 'error') {
    receiptMatchResultEl.classList.add(type);
  }
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
    // 保存不可時は無視
  }
}

function toIsoDateString(dateValue) {
  const v = String(dateValue || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return '';
}

function getCurrentReceiptDraft() {
  return {
    store_name: receiptStoreNameInputEl.value.trim(),
    store_address: receiptStoreAddressInputEl.value.trim(),
    product_name: receiptProductNameInputEl.value.trim(),
    amount_yen: receiptPriceInputEl.value.trim(),
    purchased_on: toIsoDateString(receiptPurchasedAtInputEl.value),
  };
}

function applyReceiptDraftToForm(draft) {
  if (!draft) return;
  if (draft.store_name && !receiptStoreNameInputEl.value.trim()) receiptStoreNameInputEl.value = draft.store_name;
  if (draft.store_address && !receiptStoreAddressInputEl.value.trim()) receiptStoreAddressInputEl.value = draft.store_address;
  if (draft.product_name && !receiptProductNameInputEl.value.trim()) receiptProductNameInputEl.value = draft.product_name;
  if (draft.amount_yen && !receiptPriceInputEl.value.trim()) receiptPriceInputEl.value = String(draft.amount_yen);
  if (draft.purchased_on && !receiptPurchasedAtInputEl.value) receiptPurchasedAtInputEl.value = draft.purchased_on;
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
  const selectedFile = receiptImageInputEl.files?.[0];
  currentReceiptFileKey = getReceiptFileKey(selectedFile);
  const draftMap = loadReceiptDraftMap();
  const matched = (currentReceiptFileKey && draftMap[currentReceiptFileKey]) || draftMap.__latest;
  applyReceiptDraftToForm(matched);
}

function resetMatchingState() {
  receiptPriceInputEl.readOnly = true;
  receiptMatchActionsEl.classList.add('hidden');
  setMatchResult('');
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
      setReceiptMessage('DB書き込み先が見つかりません。schema.sql を実行し、config.js の SUPABASE_RECEIPT_TABLE を確認してください。', 'error');
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

function buildMissingFieldList() {
  const missing = [];
  if (!receiptStoreNameInputEl.value.trim()) missing.push('店舗名');
  if (!receiptStoreAddressInputEl.value.trim()) missing.push('店舗住所');
  if (!receiptProductNameInputEl.value.trim()) missing.push('商品名');
  if (!receiptPriceInputEl.value.trim()) missing.push('金額');
  if (!toIsoDateString(receiptPurchasedAtInputEl.value)) missing.push('購入日');
  return missing;
}

async function findClosestPriceCandidate(storeName, productName) {
  const headers = {
    apikey: CONFIG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
  };
  const params = new URLSearchParams({ select: 'store_name,group_name,price,valid_date' });
  params.append('store_name', `ilike.*${storeName}*`);
  params.append('group_name', `ilike.*${productName}*`);
  params.append('order', 'valid_date.desc');
  params.append('limit', '20');

  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_VIEW}?${params.toString()}`, { headers });
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
    const normalizedValidDate = String(best.valid_date || '').replaceAll('-', '');
    setMatchResult(`候補: ${best.store_name} / ${best.group_name} / ${best.price}円（${formatDate(normalizedValidDate)}時点） / 未入力: ${missing.join('・') || 'なし'}`, missing.length ? 'error' : 'success');
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
  setReceiptMessage('金額を確定しました。投稿できます。', 'success');
}

function enableManualPriceEdit() {
  receiptPriceInputEl.readOnly = false;
  receiptPriceInputEl.focus();
  setReceiptMessage('金額を修正してください。修正後はそのまま投稿できます。', 'success');
}

receiptFormEl.addEventListener('submit', submitReceipt);
receiptMatchButtonEl.addEventListener('click', matchReceiptPriceWithDb);
receiptPriceOkButtonEl.addEventListener('click', confirmMatchedPrice);
receiptPriceEditButtonEl.addEventListener('click', enableManualPriceEdit);

receiptImageInputEl.addEventListener('change', () => {
  resetMatchingState();
  restoreDraftForSelectedFile();
});
receiptStoreNameInputEl.addEventListener('input', () => {
  resetMatchingState();
  persistReceiptDraft({ includeGlobal: true });
});
receiptStoreAddressInputEl.addEventListener('input', () => persistReceiptDraft({ includeGlobal: true }));
receiptProductNameInputEl.addEventListener('input', () => {
  resetMatchingState();
  persistReceiptDraft({ includeGlobal: true });
});
receiptPriceInputEl.addEventListener('input', () => persistReceiptDraft({ includeGlobal: true }));
receiptPurchasedAtInputEl.addEventListener('change', () => persistReceiptDraft({ includeGlobal: true }));

window.addEventListener('load', () => {
  applyReceiptDraftToForm(loadReceiptDraftMap().__latest);
  resetMatchingState();
});
