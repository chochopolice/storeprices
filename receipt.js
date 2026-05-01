/**
 * receipt.js  ─  レシート投稿
 *
 * フロー:
 *   1. 店舗をドロップダウンで選択（stores テーブルから取得）
 *   2. レシート画像を選択
 *   3. 「AIで解析」→ Edge Function（OCRと名寄せのみ）
 *   4. 結果をテーブルに表示（商品名・グループ名・価格を編集可能）
 *   5. 「この内容で投稿する」→ normalized_prices + user_receipt_submissions に登録
 */

const storeSearchInput  = document.getElementById('storeSearchInput');
const storeSelect       = document.getElementById('storeSelect');  // hidden input (store_id)
const storeCandidates   = document.getElementById('storeCandidates');
const storeSelectedBadge = document.getElementById('storeSelectedBadge');
const purchasedOnInput  = document.getElementById('purchasedOnInput');
const uploadArea        = document.getElementById('uploadArea');
const receiptImageInput = document.getElementById('receiptImageInput');
const previewArea       = document.getElementById('previewArea');
const previewImg        = document.getElementById('previewImg');
const previewName       = document.getElementById('previewName');
const ocrStatus         = document.getElementById('ocrStatus');
const ocrButton         = document.getElementById('ocrButton');
const step2Panel        = document.getElementById('step2Panel');
const itemsBody         = document.getElementById('itemsBody');
const addRowBtn         = document.getElementById('addRowBtn');
const summaryBar        = document.getElementById('summaryBar');
const noteInput         = document.getElementById('noteInput');
const submitButton      = document.getElementById('submitButton');
const receiptMessageEl  = document.getElementById('receiptMessage');

let currentImageBase64 = '';
let currentImageMime   = '';
let ocrResult          = null;   // { ocr, matched_items }
let groupList          = [];     // product_groupsの一覧（グループ名選択用）

const headers = () => ({
  apikey:        CONFIG.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

// ── 初期化 ─────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  await loadStores();
  await loadGroups();
  purchasedOnInput.value = new Date().toISOString().slice(0, 10);
});

let allStores = [];

async function loadStores() {
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stores?select=id,name,address&order=name`,
      { headers: headers() }
    );
    allStores = await res.json();
    setupStoreSearch();
  } catch(e) {
    storeSearchInput.placeholder = '店舗の読み込みに失敗しました';
  }
}

function setupStoreSearch() {
  storeSearchInput.addEventListener('input', () => {
    const q = storeSearchInput.value.trim();
    // 選択をリセット
    storeSelect.value = '';
    storeSelectedBadge.style.display = 'none';

    if (!q) { storeCandidates.style.display = 'none'; return; }

    const matched = allStores.filter(s =>
      s.name.includes(q) || s.name.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 8);

    if (!matched.length) { storeCandidates.style.display = 'none'; return; }

    storeCandidates.innerHTML = '';
    matched.forEach(s => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid #eee;';
      div.innerHTML = `<strong>${esc(s.name)}</strong>` +
        (s.address ? `<br><span style="font-size:11px;color:#888">${esc(s.address)}</span>` : '');
      div.addEventListener('mouseenter', () => div.style.background = '#eef4fc');
      div.addEventListener('mouseleave', () => div.style.background = '');
      div.addEventListener('click', () => {
        storeSelect.value = s.id;
        storeSearchInput.value = s.name;
        storeCandidates.style.display = 'none';
        storeSelectedBadge.textContent = `✅ ${s.name}${s.address ? '（' + s.address + '）' : ''}`;
        storeSelectedBadge.style.display = 'block';
      });
      storeCandidates.appendChild(div);
    });
    storeCandidates.style.display = 'block';
  });

  // 候補以外クリックで閉じる
  document.addEventListener('click', e => {
    if (!storeCandidates.contains(e.target) && e.target !== storeSearchInput) {
      storeCandidates.style.display = 'none';
    }
  });
}

async function loadGroups() {
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/product_groups?select=id,canonical_name,category,subcategory&order=canonical_name`,
      { headers: headers() }
    );
    groupList = await res.json();
  } catch(e) {
    console.warn('product_groups 読み込み失敗:', e);
  }
}

// ── 画像選択 ────────────────────────────────────────────────────────
uploadArea.addEventListener('click', () => receiptImageInput.click());
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
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
    const [header, b64] = e.target.result.split(',');
    currentImageBase64 = b64;
    currentImageMime   = header.match(/:(.*?);/)[1];
    previewImg.src     = e.target.result;
    previewName.textContent = file.name;
    previewArea.style.display  = 'block';
    ocrButton.disabled         = false;
    step2Panel.style.display   = 'none';
    ocrStatus.style.display    = 'none';
    showMessage('', '');
  };
  reader.readAsDataURL(file);
}

// ── OCR ────────────────────────────────────────────────────────────
ocrButton.addEventListener('click', runOcr);

async function runOcr() {
  if (!currentImageBase64) return;
  if (!storeSelect.value) {
    showStatus('店舗を入力・選択してください。', 'error');
    storeSearchInput.focus();
    return;
  }

  ocrButton.disabled = true;
  showStatus('AIでレシートを解析・名寄せ中...（10〜20秒かかります）', 'running');
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
      body: JSON.stringify({ base64: currentImageBase64, mime: currentImageMime }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `APIエラー (${res.status})`);
    }

    ocrResult = await res.json();

    // 購入日をOCR結果で補完
    if (ocrResult.ocr?.date && !purchasedOnInput.value) {
      purchasedOnInput.value = ocrResult.ocr.date;
    }

    renderTable(ocrResult.matched_items || []);
    showStatus(`解析完了。内容を確認して「投稿する」を押してください。`, 'done');
    step2Panel.style.display = 'block';
    step2Panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    showStatus(`エラー: ${err.message}`, 'error');
  } finally {
    ocrButton.disabled = false;
  }
}

// ── テーブル描画（編集可能） ────────────────────────────────────────
function renderTable(items) {
  itemsBody.innerHTML = '';
  items.forEach((item, i) => addTableRow(item, i));
  updateSummary();
}

function addTableRow(item = {}, index = null) {
  const tr = document.createElement('tr');
  tr.className = item.matched ? 'matched' : 'unmatched';
  tr.dataset.matched  = item.matched ? '1' : '0';
  tr.dataset.groupId  = item.group_id || '';
  tr.dataset.category = item.category || '';
  tr.dataset.subcategory = item.subcategory || '';

  const allSubcategories = Array.from(new Set(
    groupList
      .map(g => (g.subcategory || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, 'ja'));

  const selectedSubcategory = item.subcategory || '';

  const subcategoryOptions = allSubcategories.map(sub =>
    `<option value="${esc(sub)}" ${sub === selectedSubcategory ? 'selected' : ''}>${esc(sub)}</option>`
  ).join('');

  const buildGroupOptions = (subcategory) => {
    const filtered = subcategory
      ? groupList.filter(g => (g.subcategory || '') === subcategory)
      : groupList;
    const currentGroupId = item.group_id || '';
    return filtered.map(g =>
      `<option value="${esc(g.id)}" data-cat="${esc(g.category)}" data-sub="${esc(g.subcategory)}"
        ${String(g.id) === String(currentGroupId) ? 'selected' : ''}>${esc(g.canonical_name)}</option>`
    ).join('');
  };

  tr.innerHTML = `
    <td><input type="text" value="${esc(item.raw_name || '')}" class="inp-name" placeholder="商品名" /></td>
    <td>
      <select class="inp-subcategory">
        <option value="">（指定なし）</option>
        ${subcategoryOptions}
      </select>
    </td>
    <td>
      <select class="inp-group">
        <option value="">（未照合）</option>
        ${buildGroupOptions(selectedSubcategory)}
      </select>
    </td>
    <td><input type="number" value="${item.price != null ? item.price : ''}" class="inp-price" min="1" placeholder="円" /></td>
    <td><span class="match-badge ${item.matched ? 'ok' : 'ng'}" id="badge-${tr.dataset.idx}">
      ${item.matched ? '🟢 照合済' : '🟡 未照合'}
    </span></td>
    <td><button class="del-btn" type="button">✕</button></td>`;

  const subcategorySel = tr.querySelector('.inp-subcategory');
  const groupSel = tr.querySelector('.inp-group');

  subcategorySel.addEventListener('change', e => {
    const selectedSub = e.target.value;
    tr.dataset.subcategory = selectedSub;

    groupSel.innerHTML = `<option value="">（未照合）</option>${buildGroupOptions(selectedSub)}`;

    const selectedOpt = groupSel.options[groupSel.selectedIndex];
    tr.dataset.groupId = groupSel.value;
    tr.dataset.category = selectedOpt?.dataset?.cat || '';

    const badge = tr.querySelector('.match-badge');
    if (groupSel.value) {
      tr.dataset.matched = '1';
      tr.className = 'matched';
      badge.className = 'match-badge ok';
      badge.textContent = '🟢 照合済';
    } else {
      tr.dataset.matched = '0';
      tr.className = 'unmatched';
      badge.className = 'match-badge ng';
      badge.textContent = '🟡 未照合';
    }
    updateSummary();
  });

  // グループ変更時にバッジとデータ更新
  groupSel.addEventListener('change', e => {
    const sel = e.target;
    const opt = sel.options[sel.selectedIndex];
    tr.dataset.groupId    = sel.value;
    tr.dataset.category   = opt.dataset.cat || '';
    tr.dataset.subcategory = opt.dataset.sub || '';
    if (tr.dataset.subcategory) subcategorySel.value = tr.dataset.subcategory;
    const badge = tr.querySelector('.match-badge');
    if (sel.value) {
      tr.dataset.matched = '1';
      tr.className = 'matched';
      badge.className = 'match-badge ok';
      badge.textContent = '🟢 照合済';
    } else {
      tr.dataset.matched = '0';
      tr.className = 'unmatched';
      badge.className = 'match-badge ng';
      badge.textContent = '🟡 未照合';
    }
    updateSummary();
  });

  // 削除
  tr.querySelector('.del-btn').addEventListener('click', () => {
    tr.remove();
    updateSummary();
  });

  itemsBody.appendChild(tr);
  updateSummary();
  return tr;
}

function updateSummary() {
  const rows = [...itemsBody.querySelectorAll('tr')];
  const matched = rows.filter(r => r.dataset.matched === '1').length;
  summaryBar.textContent = `全${rows.length}件 / DB照合済み: ${matched}件 / 未照合: ${rows.length - matched}件`;
}

// 行追加
addRowBtn.addEventListener('click', () => {
  addTableRow({});
  itemsBody.lastElementChild?.querySelector('.inp-name')?.focus();
});

// ── 投稿 ───────────────────────────────────────────────────────────
submitButton.addEventListener('click', submitReceipt);

async function submitReceipt() {
  const storeId    = storeSelect.value;
  const purchasedOn = purchasedOnInput.value || new Date().toISOString().slice(0, 10);
  const note       = noteInput.value.trim();

  if (!storeId) {
    showMessage('店舗を選択してください。', 'error');
    return;
  }

  // テーブルから現在の値を収集
  const rows = [...itemsBody.querySelectorAll('tr')];
  const lineItems = rows.map(tr => ({
    raw_name:       tr.querySelector('.inp-name')?.value?.trim() || '',
    price:          Number(tr.querySelector('.inp-price')?.value) || null,
    group_id:       tr.dataset.groupId || null,
    canonical_name: tr.querySelector('.inp-group')?.options[tr.querySelector('.inp-group').selectedIndex]?.textContent || null,
    category:       tr.dataset.category || null,
    subcategory:    tr.dataset.subcategory || null,
    matched:        tr.dataset.matched === '1',
  })).filter(r => r.raw_name || r.price);

  if (lineItems.length === 0) {
    showMessage('商品が1件もありません。', 'error');
    return;
  }

  submitButton.disabled = true;
  showMessage('投稿中...', '');

  try {
    // ① normalized_prices に INSERT（照合済み商品のみ）
    const priceRows = lineItems
      .filter(i => i.group_id && i.price)
      .map(i => ({
        store_id:         storeId,
        product_group_id: i.group_id,
        item_name:        i.raw_name,
        price:            i.price,
        valid_from:       purchasedOn,
        is_sale:          false,
      }));

    if (priceRows.length > 0) {
      const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/normalized_prices`, {
        method: 'POST',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify(priceRows),
      });
      if (!r.ok) throw new Error(`価格DB登録失敗 (${r.status})`);
    }

    // ② user_receipt_submissions に INSERT
    const r2 = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/user_receipt_submissions`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        store_id:     storeId,
        store_name:   storeSearchInput.value.trim(),
        purchased_on: purchasedOn,
        line_items:   lineItems,
        note:         note || null,
        source_type:  'user_receipt',
        raw_ocr_text: ocrResult ? JSON.stringify(ocrResult.ocr) : null,
      }),
    });
    if (!r2.ok) throw new Error(`投稿記録保存失敗 (${r2.status})`);

    // ③ ビュー更新
    await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/refresh_price_view`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
    });

    showMessage(
      `投稿完了！価格DB登録: ${priceRows.length}件 ／ 未照合: ${lineItems.length - priceRows.length}件`,
      'success'
    );

    // リセット
    setTimeout(() => {
      step2Panel.style.display = 'none';
      ocrStatus.style.display  = 'none';
      previewArea.style.display = 'none';
      receiptImageInput.value  = '';
      currentImageBase64 = '';
      ocrButton.disabled = true;
      noteInput.value = '';
      itemsBody.innerHTML = '';
      ocrResult = null;
    }, 4000);

  } catch(err) {
    showMessage(err.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

// ── ユーティリティ ─────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
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
