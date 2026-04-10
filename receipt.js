/**
 * receipt.js  ─  レシート投稿
 *
 * フロー:
 *   1. 画像選択 → プレビュー
 *   2. 「AIで読み込む」→ Edge Function (ocr-receipt) へ送信
 *      Edge Function 内で:
 *        ① Claude OCR
 *        ② product_groups と名寄せ
 *        ③ normalized_prices に自動INSERT
 *        ④ user_receipt_submissions に保存
 *        ⑤ ビュー更新
 *   3. 結果をテーブル表示（名寄せ済み🟢 / 未照合🟡）
 */

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
const submitButton      = document.getElementById('submitButton');
const noteInput         = document.getElementById('noteInput');
const receiptMessageEl  = document.getElementById('receiptMessage');
const insertCountEl     = document.getElementById('insertCount');

let currentImageBase64 = '';
let currentImageMime   = '';
let matchedStoreId     = null;
let itemRows           = [];

// ── 画像選択 ────────────────────────────────────────────────────────
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
  if (receiptImageInput.files[0]) handleFileSelected(receiptImageInput.files[0]);
});

function handleFileSelected(file) {
  if (file.size > 5 * 1024 * 1024) {
    showStatus('画像サイズは5MB以下にしてください。', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const [header, b64] = dataUrl.split(',');
    currentImageBase64 = b64;
    currentImageMime   = header.match(/:(.*?);/)[1];
    previewImg.src     = dataUrl;
    previewName.textContent = file.name;
    previewArea.style.display  = 'block';
    ocrButton.disabled         = false;
    step2Panel.style.display   = 'none';
    ocrStatus.style.display    = 'none';
    showMessage('', '');
  };
  reader.readAsDataURL(file);
}

// ── OCR実行 ────────────────────────────────────────────────────────
ocrButton.addEventListener('click', runOcr);

async function runOcr() {
  if (!currentImageBase64) return;
  ocrButton.disabled = true;

  // 店舗照合
  const storeName = storeNameInput.value.trim();
  if (storeName) matchedStoreId = await matchStore(storeName);

  showStatus('AIでレシートを解析・DBと名寄せ中...（10〜20秒かかります）', 'running');
  step2Panel.style.display = 'none';

  try {
    const edgeUrl = CONFIG.SUPABASE_EDGE_OCR_URL;
    if (!edgeUrl) throw new Error('config.js に SUPABASE_EDGE_OCR_URL が設定されていません。');

    const res = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        base64:       currentImageBase64,
        mime:         currentImageMime,
        store_id:     matchedStoreId || null,
        purchased_on: purchasedOnInput.value || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `APIエラー (${res.status})`);
    }

    const data = await res.json();
    applyResult(data);

    const inserted = data.inserted || 0;
    showStatus(`解析完了。${inserted}件を価格DBに自動登録しました。`, 'done');
    step2Panel.style.display = 'block';
    step2Panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    showStatus(`エラー: ${err.message}`, 'error');
  } finally {
    ocrButton.disabled = false;
  }
}

// ── 結果の適用 ─────────────────────────────────────────────────────
function applyResult(data) {
  const ocr   = data.ocr || {};
  const items = data.matched_items || [];

  if (ocr.date)       purchasedOnInput.value = ocr.date;
  if (ocr.store_name && !storeNameInput.value) storeNameInput.value = ocr.store_name;

  storeMatchBadge.innerHTML = matchedStoreId
    ? `<span class="store-badge matched">✅ DB照合済み</span>`
    : `<span class="store-badge unmatched">⚠️ DB未照合（価格DBへの登録はスキップされます）</span>`;

  itemRows = items.map(i => ({...i}));
  itemsBody.innerHTML = '';
  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = item.matched ? 'matched' : 'unmatched';
    tr.innerHTML = `
      <td>${esc(item.raw_name)}</td>
      <td>${esc(item.canonical_name || '—')}</td>
      <td>${item.price != null ? item.price + '円' : '—'}</td>
      <td><span class="match-badge ${item.matched ? 'ok' : 'ng'}">
        ${item.matched ? '🟢 照合済' : '🟡 未照合'}
      </span></td>`;
    itemsBody.appendChild(tr);
  });

  const matchedCount = items.filter(i => i.matched).length;
  if (insertCountEl) {
    insertCountEl.textContent =
      `価格DB登録: ${matchedCount}件 ／ 未登録: ${items.length - matchedCount}件`;
  }
}

// ── 店舗照合 ────────────────────────────────────────────────────────
async function matchStore(storeName) {
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stores?select=id,name&name=ilike.*${encodeURIComponent(storeName)}*&limit=5`,
      { headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    const norm = t => String(t||'').toLowerCase().replace(/\s/g,'');
    return rows.sort((a,b) => {
      const sa = norm(a.name), sb = norm(b.name), sn = norm(storeName);
      return (sb.includes(sn) ? 1 : 0) - (sa.includes(sn) ? 1 : 0);
    })[0].id;
  } catch { return null; }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}

function showStatus(msg, state = 'info') {
  ocrStatus.style.display = 'flex';
  ocrStatus.className = `ocr-status ${state}`;
  ocrStatus.innerHTML = state === 'running'
    ? `<div class="spinner"></div><span>${msg}</span>`
    : `<span>${msg}</span>`;
}

function showMessage(msg, type = '') {
  receiptMessageEl.textContent = msg;
  receiptMessageEl.className   = `receipt-message ${type}`;
}

// ── 行追加 ─────────────────────────────────────────────────────────
if (addRowBtn) {
  addRowBtn.addEventListener('click', () => {
    const tr = document.createElement('tr');
    tr.className = 'unmatched';
    tr.innerHTML = `
      <td><input type="text" placeholder="商品名" /></td>
      <td>—</td>
      <td><input type="number" placeholder="円" min="1" /></td>
      <td><span class="match-badge ng">🟡 未照合</span></td>`;
    itemsBody.appendChild(tr);
  });
}

// ── 投稿完了確認（Edge Functionが読み込み時点で自動登録済み） ───────
if (submitButton) {
  submitButton.addEventListener('click', () => {
    showMessage('登録済みです。レシートを読み込んだ時点でDBへの価格登録が完了しています。', 'success');
  });
}
