// ===== Constants =====
const STORAGE_KEYS = {
  expenses: 'ledger_expenses_v1', // holds both expense and income transactions
  budgets: 'ledger_budgets_v1',
  categories: 'ledger_categories_v1'
};

const DEFAULT_CATEGORIES = {
  expense: ['Food', 'Groceries', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Health', 'Other'],
  income: ['Salary', 'Freelance', 'Interest', 'Refund', 'Gift', 'Other']
};

// ===== Storage helpers =====
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function getExpenses() { return loadJSON(STORAGE_KEYS.expenses, []); }
function setExpenses(list) { saveJSON(STORAGE_KEYS.expenses, list); }

function getBudgets() { return loadJSON(STORAGE_KEYS.budgets, { overall: null, categories: {} }); }
function setBudgets(b) { saveJSON(STORAGE_KEYS.budgets, b); }

// Categories are stored per-type. Older data (a flat array) is treated as the expense list.
function getCategories(type) {
  const raw = loadJSON(STORAGE_KEYS.categories, null);
  if (Array.isArray(raw)) return type === 'expense' ? raw : DEFAULT_CATEGORIES.income.slice();
  if (raw && raw[type]) return raw[type];
  return DEFAULT_CATEGORIES[type].slice();
}
function setCategories(type, list) {
  const raw = loadJSON(STORAGE_KEYS.categories, null);
  const normalized = (raw && !Array.isArray(raw)) ? raw : { expense: Array.isArray(raw) ? raw : DEFAULT_CATEGORIES.expense.slice() };
  normalized[type] = list;
  saveJSON(STORAGE_KEYS.categories, normalized);
}

// ===== Utilities =====
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function monthKeyOf(dateStr) { return dateStr.slice(0, 7); }

function typeOf(e) { return e.type === 'income' ? 'income' : 'expense'; }

function fmtAmount(n) {
  const num = Number(n) || 0;
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function escapeHTML(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Duplicate-detection fingerprints =====
function normalizeDesc(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}
function makeFingerprint(date, amount, desc) {
  return `${date}|${Math.round(amount * 100)}|${normalizeDesc(desc)}`;
}
function fingerprintOf(e) {
  return e.fingerprint || makeFingerprint(e.date, e.amount, e.note || e.category || '');
}
// 'exact' = same date+amount+description already logged (safe to skip)
// 'possible' = same date+amount but different description (needs a human look)
// null = looks new
function matchExisting(candidate, existingList) {
  const cFp = makeFingerprint(candidate.date, candidate.amount, candidate.description);
  let possible = false;
  for (const e of existingList) {
    if (fingerprintOf(e) === cFp) return 'exact';
    if (e.date === candidate.date && Math.round(e.amount * 100) === Math.round(candidate.amount * 100)) possible = true;
  }
  return possible ? 'possible' : null;
}

// ===== Parser for pasted bank / UPI text =====
function parseTransactionText(text) {
  const result = { amount: null, merchant: '', direction: null };
  if (!text) return result;

  let m = text.match(/(?:rs\.?|inr|₹)\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) m = text.match(/([\d,]+\.\d{2})\b/);
  if (m) result.amount = parseFloat(m[1].replace(/,/g, ''));

  if (/debit|debited|spent|paid|purchase|withdrawn|sent|deducted/i.test(text)) result.direction = 'debit';
  else if (/credit|credited|received|refund(?:ed)?/i.test(text)) result.direction = 'credit';

  const merchantPatterns = [
    /VPA\s+([A-Za-z0-9@.\-_]{3,40})/i,
    /(?:trf to|transfer to|towards|to|at)\s+([A-Za-z0-9@.\-_&' ]{2,40}?)(?:\s+on\b|\s+via\b|\s+upi\b|\s+ref\b|[.,\n]|$)/i
  ];
  for (const p of merchantPatterns) {
    const mm = text.match(p);
    if (mm && mm[1].trim().length > 1) { result.merchant = mm[1].trim().replace(/[.\s]+$/, ''); break; }
  }
  return result;
}

// ===== Navigation =====
let currentScreen = 'home';
function switchScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'charts') renderCharts();
  if (name === 'settings') renderSettings();
  if (name === 'add') renderAdd();
  window.scrollTo(0, 0);
}

// ===== Toast / notifications =====
let toastTimer;
function showToast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind === 'alert' ? ' alert' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
}

function notifyBudget(msg) {
  showToast(msg, 'alert');
  if (window.Notification && Notification.permission === 'granted') {
    try { new Notification('Over budget', { body: msg, icon: 'icon-192.png' }); } catch (e) {}
  }
}

function checkBudgetsAfterAdd(txn) {
  const budgets = getBudgets();
  const all = getExpenses();
  const mKey = monthKeyOf(txn.date);
  const monthExpenses = all.filter(e => monthKeyOf(e.date) === mKey && typeOf(e) === 'expense');

  const catTotal = monthExpenses.filter(e => e.category === txn.category).reduce((s, e) => s + e.amount, 0);
  const overallTotal = monthExpenses.reduce((s, e) => s + e.amount, 0);

  const catLimit = budgets.categories[txn.category];
  if (catLimit && catTotal > catLimit) {
    notifyBudget(`${txn.category} is over budget: ${fmtAmount(catTotal)} of ${fmtAmount(catLimit)}`);
  }
  if (budgets.overall && overallTotal > budgets.overall) {
    notifyBudget(`Monthly budget exceeded: ${fmtAmount(overallTotal)} of ${fmtAmount(budgets.overall)}`);
  }
}

// ===== Render: Home =====
function renderHome() {
  const all = getExpenses();
  const budgets = getBudgets();
  const today = todayISO();
  const mKey = monthKeyOf(today);

  const monthTxns = all.filter(e => monthKeyOf(e.date) === mKey);
  const monthExpenses = monthTxns.filter(e => typeOf(e) === 'expense');
  const monthIncome = monthTxns.filter(e => typeOf(e) === 'income');

  const todaySpent = all.filter(e => e.date === today && typeOf(e) === 'expense').reduce((s, e) => s + e.amount, 0);
  const monthExpenseTotal = monthExpenses.reduce((s, e) => s + e.amount, 0);
  const monthIncomeTotal = monthIncome.reduce((s, e) => s + e.amount, 0);
  const net = monthIncomeTotal - monthExpenseTotal;

  const overall = budgets.overall;
  const pct = overall ? Math.min(100, (monthExpenseTotal / overall) * 100) : 0;
  const over = overall && monthExpenseTotal > overall;

  const ringR = 58;
  const ringCirc = 2 * Math.PI * ringR;
  const ringOffset = ringCirc * (1 - pct / 100);

  let html = `
    <div class="hero-card">
      <div class="ring-wrap">
        <svg viewBox="0 0 140 140" class="budget-ring">
          <circle class="ring-track" cx="70" cy="70" r="${ringR}"></circle>
          ${overall ? `<circle class="ring-fill ${over ? 'over' : ''}" cx="70" cy="70" r="${ringR}" style="stroke-dasharray:${ringCirc.toFixed(1)};stroke-dashoffset:${ringOffset.toFixed(1)}"></circle>` : ''}
        </svg>
        <div class="ring-center">
          <div class="ring-value ${over ? 'over' : ''}">${fmtAmount(monthExpenseTotal)}</div>
          <div class="ring-label">${overall ? 'of ' + fmtAmount(overall) + ' budget' : 'spent this month'}</div>
        </div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><span class="label">Spent today</span><span class="amount">${fmtAmount(todaySpent)}</span></div>
      <div class="stat-card"><span class="label">Income this month</span><span class="amount income">${fmtAmount(monthIncomeTotal)}</span></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><span class="label">Net this month</span><span class="amount ${net < 0 ? 'over' : 'income'}">${net < 0 ? '-' : ''}${fmtAmount(Math.abs(net))}</span></div>
      <div class="stat-card"><span class="label">Transactions</span><span class="amount">${monthTxns.length}</span></div>
    </div>
  `;

  const catTotals = {};
  monthExpenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
  const sortedCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  html += '<div class="section-title">Expenses by category</div>';
  if (sortedCats.length === 0) {
    html += '<div class="empty">No expenses logged this month yet.</div>';
  } else {
    const maxCat = Math.max(...sortedCats.map(c => c[1]));
    sortedCats.forEach(([cat, amt]) => {
      const limit = budgets.categories[cat];
      const catOver = limit && amt > limit;
      const barPct = limit ? Math.min(100, (amt / limit) * 100) : Math.min(100, (amt / maxCat) * 100);
      html += `
        <div class="cat-pill-row">
          <div class="cat-pill-top"><span class="cat-name">${cat}</span><span class="amount">${fmtAmount(amt)}${limit ? ' / ' + fmtAmount(limit) : ''}</span></div>
          <div class="cat-pill-track"><div class="cat-pill-fill ${catOver ? 'over' : ''}" style="width:${barPct}%"></div></div>
        </div>`;
    });
  }

  html += '<div class="section-title">Recent</div>';
  const recent = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  if (recent.length === 0) {
    html += '<div class="empty">Nothing logged yet. Tap Add below to get started.</div>';
  } else {
    recent.forEach(e => { html += renderTxnRow(e, false); });
  }

  document.getElementById('screen-home').innerHTML = html;
}

const CATEGORY_COLORS = ['#3ECF8E', '#FFB454', '#FF6B52', '#5FA8D3', '#B98CE8', '#4CC9C0', '#F2C14E', '#E8846B'];
function colorForCategory(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

function renderTxnRow(e, showActions) {
  const isIncome = typeOf(e) === 'income';
  const avatarColor = colorForCategory(e.category);
  let row = `<div class="txn-row" data-id="${e.id}">`;
  row += `<div class="txn-avatar" style="background:${avatarColor}">${escapeHTML(e.category.charAt(0).toUpperCase())}</div>`;
  row += `<div class="txn-info"><span class="txn-cat">${e.category}</span><span class="txn-meta">${fmtDateLabel(e.date)}${e.note ? ' · ' + escapeHTML(e.note) : ''}</span></div>`;
  row += `<div class="txn-amount ${isIncome ? 'income' : ''}">${isIncome ? '+' : '-'}${fmtAmount(e.amount)}</div>`;
  if (showActions) {
    row += `<div class="txn-actions"><button onclick="editExpense('${e.id}')">Edit</button><button onclick="deleteExpense('${e.id}')">Delete</button></div>`;
  }
  row += '</div>';
  return row;
}

// ===== Render: Add =====
let editingId = null;
let addType = 'expense';

function updateTypeUI() {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === addType));
  const categories = getCategories(addType);
  const sel = document.getElementById('fCategory');
  if (sel) sel.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');
  const saveBtn = document.getElementById('saveExpenseBtn');
  if (saveBtn) saveBtn.textContent = editingId ? 'Save changes' : (addType === 'income' ? 'Add income' : 'Add expense');
}

function renderAdd(txnToEdit) {
  editingId = txnToEdit ? txnToEdit.id : null;
  addType = txnToEdit ? typeOf(txnToEdit) : 'expense';
  const categories = getCategories(addType);
  const catOptions = categories.map(c => `<option value="${c}" ${txnToEdit && txnToEdit.category === c ? 'selected' : ''}>${c}</option>`).join('');

  const html = `
    <div class="type-toggle">
      <button class="type-btn ${addType === 'expense' ? 'active' : ''}" data-type="expense">Expense</button>
      <button class="type-btn ${addType === 'income' ? 'active' : ''}" data-type="income">Income</button>
    </div>
    <div class="paste-box">
      <label>Paste a bank / UPI message</label>
      <textarea id="pasteInput" placeholder="Paste the SMS or email text here…"></textarea>
      <div class="hint">We'll try to pull out the amount, merchant, and whether it's money in or out.</div>
    </div>
    <div class="field">
      <label>Amount</label>
      <input type="number" id="fAmount" inputmode="decimal" placeholder="0.00" value="${txnToEdit ? txnToEdit.amount : ''}">
    </div>
    <div class="field">
      <label>Category</label>
      <select id="fCategory">${catOptions}</select>
    </div>
    <div class="field">
      <label>Note / merchant</label>
      <input type="text" id="fNote" placeholder="Optional" value="${txnToEdit ? escapeHTML(txnToEdit.note || '') : ''}">
    </div>
    <div class="field">
      <label>Date</label>
      <input type="date" id="fDate" value="${txnToEdit ? txnToEdit.date : todayISO()}">
    </div>
    <button class="btn" id="saveExpenseBtn">${txnToEdit ? 'Save changes' : (addType === 'income' ? 'Add income' : 'Add expense')}</button>
  `;
  document.getElementById('screen-add').innerHTML = html;

  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (addType === btn.dataset.type) return;
      addType = btn.dataset.type;
      updateTypeUI();
    });
  });

  document.getElementById('pasteInput').addEventListener('input', (e) => {
    const parsed = parseTransactionText(e.target.value);
    const impliedType = parsed.direction === 'credit' ? 'income' : parsed.direction === 'debit' ? 'expense' : null;
    if (impliedType && impliedType !== addType) {
      addType = impliedType;
      updateTypeUI();
      showToast(impliedType === 'income' ? 'Looks like income — switched to Income.' : 'Switched to Expense.');
    }
    if (parsed.amount) document.getElementById('fAmount').value = parsed.amount;
    if (parsed.merchant) document.getElementById('fNote').value = parsed.merchant;
  });

  document.getElementById('saveExpenseBtn').addEventListener('click', saveExpenseFromForm);
}

function saveExpenseFromForm() {
  const amount = parseFloat(document.getElementById('fAmount').value);
  const category = document.getElementById('fCategory').value;
  const note = document.getElementById('fNote').value.trim();
  const date = document.getElementById('fDate').value || todayISO();
  const type = addType;

  if (!amount || amount <= 0) {
    showToast('Enter a valid amount first.');
    return;
  }

  const expenses = getExpenses();

  if (editingId) {
    const idx = expenses.findIndex(x => x.id === editingId);
    if (idx > -1) expenses[idx] = { ...expenses[idx], amount, category, note, date, type, fingerprint: makeFingerprint(date, amount, note || category) };
    setExpenses(expenses);
    showToast('Changes saved.');
    editingId = null;
  } else {
    const txn = { id: uid(), amount, category, note, date, type, fingerprint: makeFingerprint(date, amount, note || category), createdAt: Date.now() };
    expenses.push(txn);
    setExpenses(expenses);
    showToast(type === 'income' ? 'Income added.' : 'Expense added.');
    if (type === 'expense') checkBudgetsAfterAdd(txn);
  }

  switchScreen('home');
}

function editExpense(id) {
  const e = getExpenses().find(x => x.id === id);
  if (!e) return;
  switchScreen('add');
  renderAdd(e);
}

function deleteExpense(id) {
  if (!confirm('Delete this entry?')) return;
  setExpenses(getExpenses().filter(x => x.id !== id));
  renderHistory();
}

// ===== Render: History =====
let historyFilter = 'all';
let historyType = 'all';

function renderHistory() {
  const typeChips = ['all', 'expense', 'income'].map(t =>
    `<button class="chip ${historyType === t ? 'active' : ''}" data-type-filter="${t}">${t === 'all' ? 'All' : t === 'expense' ? 'Expense' : 'Income'}</button>`
  ).join('');

  const catSource = historyType === 'income' ? getCategories('income')
    : historyType === 'expense' ? getCategories('expense')
    : [...new Set([...getCategories('expense'), ...getCategories('income')])];
  const categories = ['all', ...catSource];
  const catChips = categories.map(c => `<button class="chip ${historyFilter === c ? 'active' : ''}" data-cat="${c}">${c === 'all' ? 'All categories' : c}</button>`).join('');

  let html = `<div class="chip-row">${typeChips}</div>`;
  html += `<div class="chip-row">${catChips}</div>`;
  html += '<button class="small-link" id="exportCsvBtn" style="margin-bottom:16px;display:inline-block;">Export CSV</button>';

  const expenses = getExpenses()
    .filter(e => historyType === 'all' || typeOf(e) === historyType)
    .filter(e => historyFilter === 'all' || e.category === historyFilter)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  if (expenses.length === 0) {
    html += '<div class="empty">No transactions in this view.</div>';
  } else {
    expenses.forEach(e => { html += renderTxnRow(e, true); });
  }

  document.getElementById('screen-history').innerHTML = html;

  document.querySelectorAll('[data-type-filter]').forEach(chip => {
    chip.addEventListener('click', () => { historyType = chip.dataset.typeFilter; historyFilter = 'all'; renderHistory(); });
  });
  document.querySelectorAll('[data-cat]').forEach(chip => {
    chip.addEventListener('click', () => { historyFilter = chip.dataset.cat; renderHistory(); });
  });
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
}

function exportCSV() {
  const expenses = getExpenses().sort((a, b) => a.date.localeCompare(b.date));
  let csv = 'Date,Type,Category,Amount,Note\n';
  expenses.forEach(e => {
    csv += `${e.date},${typeOf(e)},${e.category},${e.amount},"${(e.note || '').replace(/"/g, '""')}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${todayISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== Render: Charts =====
let categoryChart, trendChart;

function renderCharts() {
  document.getElementById('screen-charts').innerHTML = `
    <div class="section-title">Last 6 months — income vs expenses</div>
    <div class="chart-wrap"><div style="position:relative;height:200px;"><canvas id="trendCanvas"></canvas></div></div>
    <div class="section-title">Expenses this month by category</div>
    <div class="chart-wrap"><div style="position:relative;height:220px;"><canvas id="catCanvas"></canvas></div></div>
  `;

  const all = getExpenses();
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const expenseTotals = months.map(m => all.filter(e => monthKeyOf(e.date) === m && typeOf(e) === 'expense').reduce((s, e) => s + e.amount, 0));
  const incomeTotals = months.map(m => all.filter(e => monthKeyOf(e.date) === m && typeOf(e) === 'income').reduce((s, e) => s + e.amount, 0));
  const monthLabels = months.map(m => {
    const [y, mo] = m.split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
  });

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('trendCanvas'), {
    type: 'bar',
    data: {
      labels: monthLabels,
      datasets: [
        { label: 'Income', data: incomeTotals, backgroundColor: '#3ECF8E', borderRadius: 6 },
        { label: 'Expenses', data: expenseTotals, backgroundColor: '#FF6B52', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#9C9384', font: { family: 'Inter' }, boxWidth: 12 } } },
      scales: {
        y: { ticks: { color: '#9C9384', callback: (v) => '₹' + v }, grid: { color: '#3A3223' } },
        x: { ticks: { color: '#9C9384' }, grid: { display: false } }
      }
    }
  });

  const mKey = monthKeyOf(todayISO());
  const monthExpenses = all.filter(e => monthKeyOf(e.date) === mKey && typeOf(e) === 'expense');
  const catTotals = {};
  monthExpenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  if (categoryChart) categoryChart.destroy();
  const palette = catEntries.map(c => colorForCategory(c[0]));
  categoryChart = new Chart(document.getElementById('catCanvas'), {
    type: 'doughnut',
    data: { labels: catEntries.map(c => c[0]), datasets: [{ data: catEntries.map(c => c[1]), backgroundColor: palette, borderColor: '#201C15', borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#9C9384', font: { family: 'Inter' }, boxWidth: 12 } } }
    }
  });
}

// ===== Render: Settings =====
function renderSettings() {
  const budgets = getBudgets();
  const expenseCats = getCategories('expense');
  const incomeCats = getCategories('income');

  let html = `
    <div class="section-title">Expense budget</div>
    <div class="field">
      <label>Overall monthly limit</label>
      <input type="number" id="overallBudget" placeholder="e.g. 20000" value="${budgets.overall || ''}">
    </div>
    <div class="section-title">Category limits</div>
  `;
  expenseCats.forEach(c => {
    html += `<div class="budget-row"><span class="cat-name">${c}</span><input type="number" data-cat="${c}" class="catBudgetInput" placeholder="No limit" value="${budgets.categories[c] || ''}"></div>`;
  });
  html += '<button class="btn" id="saveBudgetsBtn" style="margin-top:16px;">Save budgets</button>';

  html += `
    <div class="section-title">Expense categories</div>
    <div class="field">
      <label>Add an expense category</label>
      <div class="btn-row">
        <input type="text" id="newExpCatInput" placeholder="e.g. Travel" style="width:auto;flex:1;">
        <button class="btn secondary" id="addExpCatBtn" style="width:auto;padding:11px 16px;">Add</button>
      </div>
    </div>

    <div class="section-title">Income categories</div>
    <div class="field">
      <label>Add an income category</label>
      <div class="btn-row">
        <input type="text" id="newIncCatInput" placeholder="e.g. Bonus" style="width:auto;flex:1;">
        <button class="btn secondary" id="addIncCatBtn" style="width:auto;padding:11px 16px;">Add</button>
      </div>
    </div>

    <div class="section-title">Import a statement</div>
    <div class="hint" style="margin-bottom:10px;">Add transactions in bulk from a bank statement PDF. Runs on your device — the file and password are never uploaded anywhere.</div>
    <button class="btn secondary" id="importStatementBtn">Import statement (PDF)</button>

    <div class="section-title">Notifications</div>
    <button class="btn secondary" id="notifPermBtn">Enable over-budget alerts</button>

    <div class="section-title">Data</div>
    <div class="btn-row" style="margin-bottom:10px;">
      <button class="btn secondary" id="exportJsonBtn">Backup (JSON)</button>
      <button class="btn secondary" id="importJsonBtn">Restore</button>
    </div>
    <input type="file" id="importJsonFile" accept="application/json" style="display:none;">
    <button class="btn danger" id="clearDataBtn">Erase all data</button>
  `;

  document.getElementById('screen-settings').innerHTML = html;

  document.getElementById('saveBudgetsBtn').addEventListener('click', () => {
    const overall = parseFloat(document.getElementById('overallBudget').value) || null;
    const catBudgets = {};
    document.querySelectorAll('.catBudgetInput').forEach(inp => {
      const v = parseFloat(inp.value);
      if (v) catBudgets[inp.dataset.cat] = v;
    });
    setBudgets({ overall, categories: catBudgets });
    showToast('Budgets saved.');
  });

  document.getElementById('addExpCatBtn').addEventListener('click', () => {
    const val = document.getElementById('newExpCatInput').value.trim();
    if (!val) return;
    const cats = getCategories('expense');
    if (!cats.includes(val)) {
      cats.push(val);
      setCategories('expense', cats);
      renderSettings();
      showToast('Category added.');
    }
  });

  document.getElementById('addIncCatBtn').addEventListener('click', () => {
    const val = document.getElementById('newIncCatInput').value.trim();
    if (!val) return;
    const cats = getCategories('income');
    if (!cats.includes(val)) {
      cats.push(val);
      setCategories('income', cats);
      renderSettings();
      showToast('Category added.');
    }
  });

  document.getElementById('notifPermBtn').addEventListener('click', async () => {
    if (!window.Notification) { showToast('Notifications are not supported here.'); return; }
    const perm = await Notification.requestPermission();
    showToast(perm === 'granted' ? 'Alerts enabled.' : 'Alerts not enabled.');
  });

  document.getElementById('importStatementBtn').addEventListener('click', renderImportStart);

  document.getElementById('exportJsonBtn').addEventListener('click', () => {
    const data = {
      expenses: getExpenses(),
      budgets: getBudgets(),
      categories: { expense: getCategories('expense'), income: getCategories('income') }
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ledger-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('importJsonBtn').addEventListener('click', () => {
    document.getElementById('importJsonFile').click();
  });

  document.getElementById('importJsonFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.expenses) setExpenses(data.expenses);
        if (data.budgets) setBudgets(data.budgets);
        if (data.categories) saveJSON(STORAGE_KEYS.categories, data.categories);
        showToast('Backup restored.');
        renderSettings();
      } catch (err) {
        showToast('Could not read that file.');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('clearDataBtn').addEventListener('click', () => {
    if (!confirm('This deletes every expense, income entry, budget, and category on this device. Continue?')) return;
    localStorage.removeItem(STORAGE_KEYS.expenses);
    localStorage.removeItem(STORAGE_KEYS.budgets);
    localStorage.removeItem(STORAGE_KEYS.categories);
    showToast('All data erased.');
    renderSettings();
  });
}

// ===== Statement import (PDF) =====
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js';
}

function showImportScreen() {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-import'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  window.scrollTo(0, 0);
}

function renderImportStart() {
  document.getElementById('screen-import').innerHTML = `
    <div class="section-title">Import statement</div>
    <div class="hint" style="margin-bottom:16px;">PDF or Excel (.xls/.xlsx) both work. This reads the file on your device only — nothing is uploaded. You'll see every row before anything is added.</div>
    <div class="field">
      <label>Statement file</label>
      <input type="file" id="pdfFileInput" accept="application/pdf,.xls,.xlsx">
    </div>
    <div class="field">
      <label>Password (PDF only, leave blank for Excel)</label>
      <input type="password" id="pdfPasswordInput" placeholder="Used once, never saved">
    </div>
    <button class="btn" id="parsePdfBtn">Read statement</button>
    <div class="hint" id="importStatus" style="margin-top:12px;"></div>
    <button class="btn secondary" id="cancelImportBtn2" style="margin-top:16px;">Cancel</button>
  `;
  document.getElementById('parsePdfBtn').addEventListener('click', handleParseStatementFile);
  document.getElementById('cancelImportBtn2').addEventListener('click', () => switchScreen('settings'));
  showImportScreen();
}

function handleParseStatementFile() {
  const file = document.getElementById('pdfFileInput').files[0];
  if (!file) { showToast('Choose a file first.'); return; }
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
    handleParseXls(file);
  } else {
    handleParsePdf(file);
  }
}

async function handleParsePdf(file) {
  const password = document.getElementById('pdfPasswordInput').value;
  const status = document.getElementById('importStatus');
  if (!window.pdfjsLib) { status.textContent = 'PDF reader failed to load — check your connection and try again.'; return; }

  status.textContent = 'Reading…';
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf, password: password || undefined }).promise;
    const lines = await extractPdfLines(pdf);
    const candidates = parseStatementLines(lines);
    if (candidates.length === 0) {
      status.textContent = "Couldn't find any transaction rows. This statement's layout may not match what we expect yet — try pasting a page of it in chat so it can be tuned.";
      return;
    }
    renderImportReview(candidates);
  } catch (err) {
    if (err && (err.name === 'PasswordException')) {
      status.textContent = 'That password didn\'t work — try again.';
    } else {
      status.textContent = 'Could not read that PDF. It may be a scanned image rather than text, which this can\'t read yet.';
    }
  }
}

async function handleParseXls(file) {
  const status = document.getElementById('importStatus');
  if (!window.XLSX) { status.textContent = 'Spreadsheet reader failed to load — check your connection and try again.'; return; }

  status.textContent = 'Reading…';
  try {
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: 'array' });
    const candidates = parseXlsWorkbook(workbook);
    if (candidates.length === 0) {
      status.textContent = "Couldn't find any transaction rows in this file. Its layout may not match what we expect yet — try describing its columns in chat so it can be tuned.";
      return;
    }
    renderImportReview(candidates);
  } catch (err) {
    status.textContent = 'Could not read that file — make sure it\'s a genuine Excel export, not a renamed CSV or HTML file.';
  }
}

// Excel statements are structured data, so unlike the PDF path there's no need to guess
// column position — but bank-to-Excel exports still drift the amount between columns
// row to row (a real conversion artifact we found), so balance continuity still does
// the heavy lifting for direction; keywords only cover the first row of each sheet.
function parseXlsWorkbook(workbook) {
  const candidates = [];
  const datePattern = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\/\-. ][A-Za-z]{3,9}[\/\-. ]\d{2,4})/;

  workbook.SheetNames.forEach(sheetName => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const sheetCandidates = [];

    rows.forEach(row => {
      // Find a date in one of the first few non-empty cells — keeps this from firing on
      // a date mentioned deep inside a paragraph of disclaimer text elsewhere in the file.
      let dateIdx = -1, date = null;
      for (let i = 0; i < Math.min(row.length, 6); i++) {
        const cell = String(row[i] || '').trim();
        if (!cell) continue;
        const dm = cell.match(datePattern);
        if (dm) { date = parseFlexibleDate(dm[0]); if (date) { dateIdx = i; break; } }
      }
      if (dateIdx === -1) return;

      // Description: first substantial non-numeric text cell after the date
      let description = '';
      for (let i = dateIdx + 1; i < row.length; i++) {
        const cell = String(row[i] || '').trim();
        if (cell && isNaN(cell.replace(/,/g, ''))) { description = cell.replace(/\n/g, ' '); break; }
      }

      // Every clean decimal-looking cell after the date is a candidate amount/balance
      const nums = [];
      for (let i = dateIdx + 1; i < row.length; i++) {
        const cell = String(row[i] || '').trim().replace(/,/g, '');
        if (cell && /^\d+\.\d{1,2}$/.test(cell)) nums.push(parseFloat(cell));
      }
      if (nums.length === 0) return;

      const amount = nums.length === 1 ? nums[0] : nums[nums.length - 2];
      const balance = nums.length >= 2 ? nums[nums.length - 1] : null;
      if (!amount) return;

      sheetCandidates.push({ date, description: description || '(no description)', amount, amountX: null, balance, raw: String(row.join(' ')) });
    });

    candidates.push(...sheetCandidates);
  });

  resolveDirections(candidates);
  resolveDirectionsFromBalance(candidates);
  return candidates;
}

async function extractPdfLines(pdf) {
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.map(it => ({ text: it.str, x: it.transform[4], y: it.transform[5] }));
    const rows = {};
    items.forEach(it => {
      const key = Math.round(it.y / 3) * 3;
      (rows[key] = rows[key] || []).push(it);
    });
    Object.keys(rows).map(Number).sort((a, b) => b - a).forEach(y => {
      const rowItems = rows[y].sort((a, b) => a.x - b.x);
      const text = rowItems.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text, items: rowItems });
    });
  }
  return lines;
}

function parseFlexibleDate(raw) {
  const monthMap = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m = raw.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (Number(mo) > 12) return null;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = raw.match(/(\d{1,2})[\/\-. ]([A-Za-z]{3,9})[\/\-. ](\d{2,4})/);
  if (m) {
    let [, d, monStr, y] = m;
    const mo = monthMap[monStr.slice(0, 3).toLowerCase()];
    if (!mo) return null;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// Best-effort row parser. Bank statement PDF layouts vary a lot, so this is a first pass —
// every row is fully editable in the review screen rather than trusted outright.
const DEBIT_WORDS = /\bdr\b|debit|withdrawal|\bwdl\b|\bpos\b|\batm\b|purchase/i;
const CREDIT_WORDS = /\bcr\b|credit|deposit|salary|refund|reversal|received/i;

function parseStatementLines(lines) {
  const datePattern = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\/\-. ][A-Za-z]{3,9}[\/\-. ]\d{2,4})/;
  const candidates = [];

  lines.forEach(line => {
    const dm = line.text.match(datePattern);
    if (!dm) return;
    const date = parseFlexibleDate(dm[0]);
    if (!date) return;

    // Pull numbers from the row's individual text items (not the flattened string) so we
    // keep each number's x-position — that position is what actually tells debit from credit.
    const numberItems = line.items
      .map(it => {
        const m = it.text.trim().match(/^[\d,]+\.\d{2}$/);
        return m ? { x: it.x, value: parseFloat(m[0].replace(/,/g, '')) } : null;
      })
      .filter(Boolean);
    if (numberItems.length === 0) return;

    const firstNumIdx = line.text.search(/[\d,]+\.\d{2}/);
    const description = (firstNumIdx > -1 ? line.text.slice(dm.index + dm[0].length, firstNumIdx) : line.text.slice(dm.index + dm[0].length))
      .replace(/[|:\-]+$/, '').trim();

    const amountItem = numberItems.length === 1 ? numberItems[0] : numberItems[numberItems.length - 2]; // last is usually the running balance
    const balanceItem = numberItems.length >= 2 ? numberItems[numberItems.length - 1] : null;
    if (!amountItem || !amountItem.value) return;

    candidates.push({ date, description: description || '(no description)', amount: amountItem.value, amountX: amountItem.x, balance: balanceItem ? balanceItem.value : null, raw: line.text });
  });

  resolveDirections(candidates);
  resolveDirectionsFromBalance(candidates);
  return candidates;
}

// The strongest signal available: if the row shows a running balance, the change from the
// previous row's balance tells you debit vs credit with certainty — no guessing needed.
// Falls back to the column/keyword guess (already set by resolveDirections) wherever the
// balance chain doesn't confirm cleanly, e.g. the very first row, or a break between pages.
function resolveDirectionsFromBalance(candidates) {
  let prevBalance = null;
  candidates.forEach(c => {
    if (c.balance != null && prevBalance != null) {
      const delta = c.balance - prevBalance;
      if (Math.abs(Math.abs(delta) - c.amount) < 0.01) {
        c.direction = delta > 0 ? 'credit' : 'debit';
        c.directionConfirmed = true;
      }
    }
    if (c.balance != null) prevBalance = c.balance;
  });
}

// Figures out which column is debit and which is credit from the statement's own layout,
// instead of guessing from words that Indian UPI narrations usually don't include at all.
function resolveDirections(candidates) {
  const xs = [...new Set(candidates.map(c => c.amountX))].sort((a, b) => a - b);

  let splitPoint = null;
  if (xs.length >= 2) {
    let bestGap = 0, bestIdx = -1;
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    const spread = xs[xs.length - 1] - xs[0];
    if (bestIdx > -1 && spread > 5 && bestGap > spread * 0.25) splitPoint = xs[bestIdx];
  }

  if (splitPoint === null) {
    // Amounts don't fall into two clear columns (e.g. a single "Amount" column with a
    // separate Dr/Cr letter) — fall back to keyword matching per row, defaulting to debit.
    candidates.forEach(c => {
      c.direction = CREDIT_WORDS.test(c.raw) ? 'credit' : 'debit';
    });
    return;
  }

  candidates.forEach(c => { c.cluster = c.amountX < splitPoint ? 'left' : 'right'; });

  let leftScore = 0, rightScore = 0;
  candidates.forEach(c => {
    const vote = CREDIT_WORDS.test(c.raw) ? 1 : DEBIT_WORDS.test(c.raw) ? -1 : 0;
    if (c.cluster === 'left') leftScore += vote; else rightScore += vote;
  });
  // If neither column has any keyword evidence, use the standard convention: the debit
  // (withdrawal) column is printed before the credit (deposit) column.
  const leftIsCredit = (leftScore === 0 && rightScore === 0) ? false : leftScore > rightScore;

  candidates.forEach(c => {
    c.direction = (c.cluster === 'left') === leftIsCredit ? 'credit' : 'debit';
  });
}

let importCandidates = [];

function guessCategory(description, type) {
  const d = (description || '').toLowerCase();
  if (type === 'income') {
    if (/salary/.test(d)) return 'Salary';
    if (/refund/.test(d)) return 'Refund';
    if (/interest/.test(d)) return 'Interest';
    return 'Other';
  }
  if (/swiggy|zomato|restaurant|hotel|dine|cafe|food/.test(d)) return 'Food';
  if (/bigbasket|grofers|supermarket|super market|kirana|grocer/.test(d)) return 'Groceries';
  if (/uber|ola|petrol|fuel|irctc|rail|metro|transport/.test(d)) return 'Transport';
  if (/amazon|flipkart|myntra/.test(d)) return 'Shopping';
  if (/electricity|broadband|recharge|\bdth\b|insurance|premium|bill/.test(d)) return 'Bills';
  if (/netflix|prime|hotstar|spotify|movie|cinema/.test(d)) return 'Entertainment';
  if (/hospital|pharmacy|clinic|medical|doctor/.test(d)) return 'Health';
  return 'Other';
}

function renderImportReview(candidates) {
  const existing = getExpenses();
  importCandidates = candidates.map((c, i) => {
    const status = matchExisting(c, existing);
    const type = c.direction === 'credit' ? 'income' : 'expense';
    return {
      ...c,
      id: 'cand-' + i,
      include: status !== 'exact',
      status,
      type,
      category: guessCategory(c.description, type)
    };
  });

  const newCount = importCandidates.filter(c => c.status !== 'exact').length;
  const dupCount = importCandidates.length - newCount;

  let html = '<div class="section-title">Review before import</div>';
  html += `<div class="hint" style="margin-bottom:16px;">${importCandidates.length} rows found — ${newCount} look new, ${dupCount} already logged (unchecked below). Check anything that reads wrong before importing.</div>`;

  importCandidates.forEach(c => {
    html += `
      <div class="import-row">
        <input type="checkbox" data-cand="${c.id}" ${c.include ? 'checked' : ''}>
        <div class="import-row-body">
          <div class="import-row-top">
            <span>${fmtDateLabel(c.date)} · ${escapeHTML(c.description).slice(0, 40)}</span>
            <span class="amount">${fmtAmount(c.amount)}</span>
          </div>
          ${c.status === 'possible' ? '<div class="import-warn">Same date and amount as something already logged — worth checking.</div>' : ''}
          ${!c.directionConfirmed ? '<div class="import-guess">Direction guessed, not balance-confirmed — double check this one.</div>' : ''}
          <div class="import-row-controls">
            <select data-field="type" data-cand="${c.id}">
              <option value="expense" ${c.type === 'expense' ? 'selected' : ''}>Expense</option>
              <option value="income" ${c.type === 'income' ? 'selected' : ''}>Income</option>
            </select>
            <select data-field="category" data-cand="${c.id}"></select>
          </div>
        </div>
      </div>`;
  });

  html += '<button class="btn" id="commitImportBtn" style="margin-top:16px;">Import selected</button>';
  html += '<button class="btn secondary" id="cancelImportBtn3" style="margin-top:10px;">Cancel</button>';

  document.getElementById('screen-import').innerHTML = html;

  importCandidates.forEach(c => {
    const sel = document.querySelector(`select[data-field="category"][data-cand="${c.id}"]`);
    sel.innerHTML = getCategories(c.type).map(cat => `<option ${cat === c.category ? 'selected' : ''}>${cat}</option>`).join('');
  });

  document.querySelectorAll('input[type="checkbox"][data-cand]').forEach(cb => {
    cb.addEventListener('change', () => {
      importCandidates.find(c => c.id === cb.dataset.cand).include = cb.checked;
    });
  });
  document.querySelectorAll('select[data-field="type"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const cand = importCandidates.find(c => c.id === sel.dataset.cand);
      cand.type = sel.value;
      cand.category = getCategories(cand.type)[0];
      const catSel = document.querySelector(`select[data-field="category"][data-cand="${cand.id}"]`);
      catSel.innerHTML = getCategories(cand.type).map(cat => `<option>${cat}</option>`).join('');
    });
  });
  document.querySelectorAll('select[data-field="category"]').forEach(sel => {
    sel.addEventListener('change', () => {
      importCandidates.find(c => c.id === sel.dataset.cand).category = sel.value;
    });
  });

  document.getElementById('commitImportBtn').addEventListener('click', commitImport);
  document.getElementById('cancelImportBtn3').addEventListener('click', () => switchScreen('settings'));

  showImportScreen();
}

function commitImport() {
  const toAdd = importCandidates.filter(c => c.include);
  if (toAdd.length === 0) { showToast('Nothing selected.'); return; }
  const expenses = getExpenses();
  toAdd.forEach(c => {
    expenses.push({
      id: uid(),
      amount: c.amount,
      category: c.category,
      note: c.description,
      date: c.date,
      type: c.type,
      fingerprint: makeFingerprint(c.date, c.amount, c.description),
      createdAt: Date.now()
    });
  });
  setExpenses(expenses);
  showToast(`Imported ${toAdd.length} transaction${toAdd.length === 1 ? '' : 's'}.`);
  switchScreen('home');
}

// ===== Init =====
function init() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
  });
  renderHome();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
