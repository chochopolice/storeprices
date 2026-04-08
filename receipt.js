/**
 * receipt.js  ─  レシート投稿（OCR → DB照合 → 確認投稿）
 *
 * フロー:
 *   1. 画像アップロード → プレビュー表示
 *   2. Anthropic API（claude-sonnet-4-20250514）でOCR
 *      → 日付・店舗名・商品一覧・価格を構造化JSON で取得
 *   3. Supabase の stores / latest_store_product_prices で照合
 *      → 店舗を特定、商品を product_group に名寄せ
 *   4. テーブルに結果表示。照合できた行は🟢、できなかった行は🟡
 *   5. ユーザが確認・修正 → user_receipt_submissions に投稿
 */

// ── DOM参照 ────────────────────────────────────────────────────────
const uploadArea        = document.getElementById('uploadArea');
const receiptImageInput = document.getElementById('receiptImageInput');
const previewArea       = document.getElementById('previewArea');
const previewImg        = document.getElementById('previewImg');
const previewName       = document.getElementById('previewName');
const ocrStatus         = document.getElementById('ocrStatus');
const ocrButton         = document.getElementById('ocrButton');
const step2Panel        = document.getElementById('step2Panel');
const purchasedOnInput  = document.getElementById('purchasedOnInput');
const storeNameInput    = document.getElementById('storeNameInput');
const storeAddressInput = document.getElementById('storeAddressInput');
const storeMatchBadge   = document.getElementById('storeMatchBadge');
const itemsBody         = document.getElementById('itemsBody');
const addRowBtn         = document.getElementById('addRowBtn');
const noteInput         = document.getElementById('noteInput');
const submitButton      = document.getElementById('submitButton');
const receiptMessageEl  = document.getElementById('receiptMessage');

let currentImageBase64 = '';   // base64（data:...を除いたもの）
let currentImageMime   = '';
let matchedStoreId     = null;
let itemRows           = [];   // { rawName, groupName, groupId, price, matched }
let latestOcrResult    = null;

// ── ユーティリティ ─────────────────────────────────────────────────
function normalize(text) {
  return String(text || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[\s\u3000\-ー_]+/g, '');
}

function tokenSim(a, b) {
  const tokA = new Set(normalize(a).split(/[^a-z0-9\u3041-\u9fff]+/i).filter(Boolean));
  const tokB = new Set(normalize(b).split(/[^a-z0-9\u3041-\u9fff]+/i).filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let hit = 0;
  tokA.forEach(t => { if (tokB.has(t)) hit++; });
  return hit / Math.max(tokA.size, tokB.size);
}

function showStatus(msg, state = 'info') {
  ocrStatus.style.display = 'flex';
  ocrStatus.className = `ocr-status ${state}`;
  ocrStatus.innerHTML = state === 'running'
    ? `<div class="spinner"></div><span>${msg}</span>`
    : `<span>${msg}</span>`;
}

function showMessage(msg, type = 'error') {
  receiptMessageEl.textContent = msg;
  receiptMessageEl.className = `receipt-message ${type}`;
}

// ── Step1: 画像選択・プレビュー ────────────────────────────────────
uploadArea.addEventListener('click', () => receiptImageInput.click());
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});
receiptImageInput.addEventListener('change', () => {
  const file = receiptImageInput.files[0];
  if (file) handleFileSelected(file);
});

function handleFileSelected(file) {
  if (file.size > 5 * 1024 * 1024) {
    showStatus('画像サイズは5MB以下にしてください。', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    // base64部分だけ抽出
    const [header, b64] = dataUrl.split(',');
    currentImageBase64 = b64;
    currentImageMime   = header.match(/:(.*?);/)[1];

    previewImg.src = dataUrl;
    previewName.textContent = file.name;
    previewArea.style.display = 'block';
    ocrButton.disabled = false;
    step2Panel.style.display = 'none';
    ocrStatus.style.display  = 'none';
    showMessage('', '');
  };
  reader.readAsDataURL(file);
}

// ── Step2: Anthropic API でOCR ─────────────────────────────────────
ocrButton.addEventListener('click', runOcr);

async function runOcr() {
  if (!currentImageBase64) return;
  ocrButton.disabled = true;
  showStatus('AIでレシートを解析中...', 'running');
  step2Panel.style.display = 'none';

  try {
    const result = await callAnthropicOcr(currentImageBase64, currentImageMime);
    latestOcrResult = result;
    showStatus('解析完了。DB照合中...', 'running');
    await applyOcrResult(result);
    showStatus('DB照合完了。内容を確認して投稿してください。', 'done');
    step2Panel.style.display = 'block';
    step2Panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showStatus(`エラー: ${err.message}`, 'error');
  } finally {
    ocrButton.disabled = false;
  }
}

async function callAnthropicOcr(base64, mime) {
  // GitHub Pages からは直接 Anthropic API を呼べないため
  // Supabase Edge Function（ocr-receipt）を中継サーバーとして使用
  const edgeUrl = CONFIG.SUPABASE_EDGE_OCR_URL;
  if (!edgeUrl) {
    throw new Error('config.js に SUPABASE_EDGE_OCR_URL が設定されていません。');
  }

  const response = await fetch(edgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        CONFIG.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ base64, mime }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `OCR API エラー (${response.status})`);
  }

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';

  // JSON部分だけ抽出してパース
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AIの応答からJSONを取得できませんでした。');
  return JSON.parse(jsonMatch[0]);
}

// ── Step3: OCR結果をDB照合して画面に反映 ───────────────────────────
async function applyOcrResult(ocr) {
  // 日付
  if (ocr.date) purchasedOnInput.value = ocr.date;
  const ocrStoreAddress = getOcrStoreAddress(ocr);

  // 店舗照合
  matchedStoreId = null;
  if (ocr.store_name) {
    storeNameInput.value = ocr.store_name;
    const storeResult = await matchStore(ocr.store_name);
    if (storeResult) {
      matchedStoreId = storeResult.id;
      storeAddressInput.value = storeResult.address || ocrStoreAddress || '';
      storeMatchBadge.innerHTML =
        `<span class="store-badge matched">✅ DB照合済み: ${storeResult.name}</span>`;
    } else {
      storeAddressInput.value = ocrStoreAddress || '';
      storeMatchBadge.innerHTML =
        `<span class="store-badge unmatched">⚠️ DB未照合 — 近い店舗が見つかりませんでした</span>`;
    }
  }

  // 商品照合
  itemRows = [];
  const items = Array.isArray(ocr.items) ? ocr.items : [];
  for (const item of items) {
    if (!item.name) continue;
    const match = await matchProduct(item.name);
    itemRows.push({
      rawName:   item.name,
      groupName: match ? match.group_name : '',
      groupId:   match ? match.group_id   : null,
      price:     item.price ?? '',
      matched:   !!match,
    });
  }

  renderItemsTable();
}

async function matchStore(storeName) {
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/stores?select=id,name,address&name=ilike.*${encodeURIComponent(storeName)}*&limit=5`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  // トークン類似度で最近似店舗を選択
  return rows
    .map(r => ({ ...r, score: tokenSim(storeName, r.name) }))
    .sort((a, b) => b.score - a.score)[0];
}

async function matchProduct(productName) {
  // product_aliases で照合（あいまいマッチ）
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/product_aliases?select=alias,group_id,product_groups(canonical_name)&alias=ilike.*${encodeURIComponent(normalize(productName))}*&limit=10`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;

  const best = rows
    .map(r => ({
      group_id:   r.group_id,
      group_name: r.product_groups?.canonical_name || r.alias,
      score:      tokenSim(productName, r.alias),
    }))
    .sort((a, b) => b.score - a.score)[0];

  return best.score > 0.2 ? best : null;
}

function getOcrStoreAddress(ocr) {
  const candidates = [ocr?.store_address, ocr?.address, ocr?.store?.address];
  return candidates.find(v => typeof v === 'string' && v.trim())?.trim() || '';
}

async function ensureStoreExists(storeName, storeAddress) {
  const create = async (payload) => fetch(`${CONFIG.SUPABASE_URL}/rest/v1/stores`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  let res = await create({ name: storeName, address: storeAddress || null });
  if (!res.ok) {
    // stores.lat/lng が NOT NULL の構成に備える
    res = await create({
      name: storeName,
      address: storeAddress || null,
      type: '不明',
      lat: 0,
      lng: 0,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`店舗情報の登録に失敗しました (${res.status}): ${err}`);
    }
  }

  const rows = await res.json();
  const created = rows?.[0];
  if (!created?.id) throw new Error('店舗情報の登録結果から store_id を取得できませんでした。');
  return created.id;
}

async function updateStoreAddressIfEmpty(storeId, storeAddress) {
  if (!storeId || !storeAddress) return;
  const getRes = await fetch(
    `${CONFIG.SUPABASE_URL}/rest/v1/stores?select=id,address&id=eq.${encodeURIComponent(storeId)}&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!getRes.ok) return;
  const rows = await getRes.json();
  const currentAddress = rows?.[0]?.address;
  if (typeof currentAddress === 'string' && currentAddress.trim()) return;

  await fetch(
    `${CONFIG.SUPABASE_URL}/rest/v1/stores?id=eq.${encodeURIComponent(storeId)}`,
    {
      method: 'PATCH',
      headers: {
        ...supabaseHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ address: storeAddress }),
    }
  );
}

function supabaseHeaders() {
  return {
    apikey:        CONFIG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
  };
}

// ── Step4: 商品テーブル描画 ────────────────────────────────────────
function renderItemsTable() {
  itemsBody.innerHTML = '';
  itemRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = row.matched ? 'matched' : 'unmatched';
    tr.innerHTML = `
      <td><input type="text" value="${esc(row.rawName)}" data-i="${i}" data-field="rawName" /></td>
      <td><input type="text" value="${esc(row.groupName)}" data-i="${i}" data-field="groupName"
            placeholder="${row.matched ? '' : 'グループ名を入力'}" /></td>
      <td><input type="number" value="${row.price !== '' ? row.price : ''}"
            data-i="${i}" data-field="price" min="1" placeholder="円" /></td>
      <td>
        <span class="match-badge ${row.matched ? 'ok' : 'ng'}">
          ${row.matched ? '🟢 照合済' : '🟡 要確認'}
        </span>
      </td>`;
    itemsBody.appendChild(tr);
  });

  // インライン編集イベント
  itemsBody.querySelectorAll('input').forEach(el => {
    el.addEventListener('change', e => {
      const i = Number(e.target.dataset.i);
      const field = e.target.dataset.field;
      if (field === 'price') {
        itemRows[i].price = e.target.value ? Number(e.target.value) : '';
      } else {
        itemRows[i][field] = e.target.value;
      }
    });
  });
}

function esc(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 行追加
addRowBtn.addEventListener('click', () => {
  itemRows.push({ rawName: '', groupName: '', groupId: null, price: '', matched: false });
  renderItemsTable();
  // 追加した行の最初のinputにフォーカス
  const lastRow = itemsBody.lastElementChild;
  lastRow?.querySelector('input')?.focus();
});

// ── Step5: 投稿 ────────────────────────────────────────────────────
submitButton.addEventListener('click', submitReceipt);

async function submitReceipt() {
  const storeName    = storeNameInput.value.trim();
  const storeAddress = storeAddressInput.value.trim();
  const purchasedOn  = purchasedOnInput.value || null;
  const note         = noteInput.value.trim();

  if (!currentImageBase64) {
    showMessage('レシート画像を選択してください。', 'error');
    return;
  }
  if (!storeName) {
    showMessage('店舗名を入力してください。', 'error');
    return;
  }

  // 商品リストの最新値を取得
  itemsBody.querySelectorAll('tr').forEach((tr, i) => {
    const inputs = tr.querySelectorAll('input');
    if (inputs[0]) itemRows[i].rawName   = inputs[0].value;
    if (inputs[1]) itemRows[i].groupName = inputs[1].value;
    if (inputs[2]) itemRows[i].price     = inputs[2].value ? Number(inputs[2].value) : null;
  });

  const lineItems = itemRows
    .filter(r => r.rawName || r.price)
    .map(r => ({
      raw_name:   r.rawName,
      group_name: r.groupName || null,
      group_id:   r.groupId   || null,
      price:      r.price     || null,
      matched:    r.matched,
    }));

  submitButton.disabled = true;
  showMessage('投稿中...', '');

  try {
    let resolvedStoreId = matchedStoreId || null;
    if (!resolvedStoreId) {
      resolvedStoreId = await ensureStoreExists(storeName, storeAddress || getOcrStoreAddress(latestOcrResult));
      matchedStoreId = resolvedStoreId;
      storeMatchBadge.innerHTML = '<span class="store-badge matched">✅ 店舗をDBに新規登録しました</span>';
    } else {
      await updateStoreAddressIfEmpty(resolvedStoreId, storeAddress || getOcrStoreAddress(latestOcrResult));
    }

    const payload = {
      store_id:      resolvedStoreId,
      store_name:    storeName,
      store_address: storeAddress || getOcrStoreAddress(latestOcrResult) || null,
      purchased_on:  purchasedOn,
      line_items:    lineItems,
      note:          note || null,
      source_type:   'user_receipt',
      raw_ocr_text:  JSON.stringify(latestOcrResult || { items: itemRows }),
    };

    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/user_receipt_submissions`,
      {
        method: 'POST',
        headers: {
          ...supabaseHeaders(),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DB書き込みに失敗しました (${res.status}): ${err}`);
    }

    showMessage('投稿ありがとうございました！DBに保存されました。', 'success');
    // フォームリセット
    setTimeout(() => {
      previewArea.style.display = 'none';
      step2Panel.style.display  = 'none';
      ocrStatus.style.display   = 'none';
      ocrButton.disabled = true;
      currentImageBase64 = '';
      latestOcrResult = null;
      receiptImageInput.value = '';
      storeNameInput.value = '';
      storeAddressInput.value = '';
      purchasedOnInput.value = '';
      noteInput.value = '';
      storeMatchBadge.innerHTML = '';
      itemRows = [];
      itemsBody.innerHTML = '';
    }, 3000);

  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}
