/* =========================================================
 * 健康打卡 PWA — 原生 JS 单页应用
 * 存储：IndexedDB（records 以 date 为主键，每天一条）
 * ========================================================= */
'use strict';

/* ---------------- 规则配置（阈值集中在此，可自行调整） ---------------- */
const RULES = {
  fastingYellow: 6.1,   // 空腹血糖 > 6.1 → 黄色提示（饮食控制）
  fastingRed: 7.0,      // 空腹血糖 > 7.0 → 红色
  ppYellow: 7.8,        // 餐后2h > 7.8 → 黄色
  ppRed: 11.1,          // 餐后2h > 11.1 → 红色
  backPainHard: 7,      // 腰痛 ≥ 7 → 禁核心训练（红线）
  waterGoal: 2500,      // 每日饮水目标 ml
  waterMin: 1500        // 最低饮水量（防肾结石脱水）
};

/* 待办事项定义（打勾即完成，可在设置页增删改排序） */
const DEFAULT_TODO_ITEMS = [
  { key: 'wake',        name: '起床' },
  { key: 'breakfast',   name: '早餐' },
  { key: 'lunch',       name: '午餐' },
  { key: 'dinner',      name: '晚餐' },
  { key: 'walk',        name: '快走' },
  { key: 'b8',          name: '八段锦' },
  { key: 'deadbug',     name: '死虫式' },
  { key: 'birddog',     name: '鸟狗式' },
  { key: 'bridge',      name: '臀桥' },
  { key: 'pushup',      name: '俯卧撑' },
  { key: 'squat',       name: '深蹲' },
  { key: 'zhanzhuang',  name: '站桩' },
  { key: 'smoke',       name: '吸烟' },
  { key: 'sleep',       name: '睡眠' }
];

function loadTodoItems() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('todo_items') || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (e) { /* 忽略损坏配置 */ }
  /* 旧配置迁移：时间轴 + 运动计划 合并为待办列表（按原顺序表） */
  try {
    const tl = JSON.parse(localStorage.getItem('tl_items') || '[]');
    const plan = JSON.parse(localStorage.getItem('plan_items') || '[]');
    let order = null;
    try { order = JSON.parse(localStorage.getItem('order_items') || 'null'); } catch (e) { /* ignore */ }
    let items = [];
    if (Array.isArray(order)) {
      order.forEach(r => {
        const i = r.indexOf(':');
        const kind = r.slice(0, i), key = r.slice(i + 1);
        const src = kind === 'plan' ? plan : tl;
        const it = Array.isArray(src) && src.find(x => x.key === key);
        if (it) items.push({ key: it.key, name: it.name });
      });
    }
    if (!items.length) {
      items = [
        ...tl.map(t => ({ key: t.key, name: t.name })),
        ...plan.map(p => ({ key: p.key, name: p.name }))
      ];
    }
    if (items.length) {
      localStorage.setItem('todo_items', JSON.stringify(items));
      return items;
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULT_TODO_ITEMS));
}

let TODO_ITEMS = loadTodoItems();

/* ---------------- IndexedDB 封装 ---------------- */
const DB = (() => {
  const NAME = 'health-pwa', VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          db.createObjectStore('records', { keyPath: 'date' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  return {
    get: date => tx('records', 'readonly', s => s.get(date)),
    put: rec => tx('records', 'readwrite', s => s.put(rec)),
    all: () => tx('records', 'readonly', s => s.getAll()),
    clear: () => tx('records', 'readwrite', s => s.clear())
  };
})();

/* IndexedDB 不可用时（如隐私模式）回退到内存，仅本次会话有效 */
const memoryStore = new Map();
const storeFallback = !('indexedDB' in window);
if (storeFallback) {
  console.warn('IndexedDB 不可用，本次会话数据仅保存在内存中');
}
const Store = {
  get: date => storeFallback ? Promise.resolve(memoryStore.get(date) || null) : DB.get(date),
  put: rec => storeFallback ? Promise.resolve(memoryStore.set(rec.date, rec)) : DB.put(rec),
  all: () => storeFallback ? Promise.resolve([...memoryStore.values()]) : DB.all(),
  clear: () => storeFallback ? Promise.resolve(memoryStore.clear()) : DB.clear()
};

/* ---------------- 工具函数 ---------------- */
const $ = sel => document.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

/* 模态框 */
function showModal({ title, html, danger, buttons }) {
  const root = $('#modal-root');
  const btns = (buttons || [{ label: '知道了', cls: 'btn-primary', act: 'close' }])
    .map((b, i) => `<button class="${b.cls || ''}" data-mbtn="${i}">${esc(b.label)}</button>`).join('');
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3 class="${danger ? 'danger' : ''}">${esc(title)}</h3>
        ${html ? `<p>${html}</p>` : ''}
        <div class="modal-btns">${btns}</div>
      </div>
    </div>`;
  root.querySelectorAll('[data-mbtn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = (buttons || [])[Number(btn.dataset.mbtn)] || {};
      root.innerHTML = '';
      if (b.act && b.act !== 'close') b.act();
    });
  });
}

/* ---------------- 数据模型 ---------------- */
function blankRecord(date) {
  const rec = {
    date,
    updatedAt: Date.now(),
    sugar: { fasting: null, postprandial: null },   // 空腹 / 餐后2h 血糖 mmol/L
    water: null,                                    // 饮水 ml
    back: { pain: null, numb: 'none' },             // 腰痛 0-10 / 腿麻 none|intermittent|persistent
    knee: { pain: null },                           // 膝盖痛 0-10
    smoke: null,                                    // 吸烟支数
    sleep: { bed: '', wake: '' },                   // 就寝 / 起床时间
    vitals: { weight: null, sys: null, dia: null, hr: null },  // 体重kg / 收缩压 / 舒张压 / 心率
    todo: {}                                        // 待办事项：todo[key] = 完成时间戳
  };
  return rec;
}

/* 兼容旧数据：补齐缺失字段 */
function normalize(rec) {
  const base = blankRecord(rec.date || todayKey());
  const out = { ...base, ...rec };
  out.sugar = { ...base.sugar, ...(rec.sugar || {}) };
  out.back = { ...base.back, ...(rec.back || {}) };
  out.knee = { ...base.knee, ...(rec.knee || {}) };
  out.sleep = { ...base.sleep, ...(rec.sleep || {}) };
  out.vitals = { ...base.vitals, ...(rec.vitals || {}) };
  out.todo = { ...(rec.todo || {}) };
  return out;
}

/* 某条待办在旧数据模型下的完成时间（计划任一时段 / 时间轴有内容），返回 0 表示未完成 */
function legacyDoneTs(rec, key) {
  const p = rec.plan && rec.plan[key];
  if (p) {
    const ts = Object.values(p).filter(Boolean);
    if (ts.length) return Math.max(...ts);
  }
  const d = rec.items && rec.items[key];
  if (d && (d.ts || d.desc || d.mins != null || d.count != null || d.time)) return d.ts || 0;
  return 0;
}

function todoDoneTs(rec, key) {
  if (rec.todo && rec.todo[key]) return rec.todo[key];
  return legacyDoneTs(rec, key);
}

function todoDoneCount(rec) {
  return TODO_ITEMS.filter(it => todoDoneTs(rec, it.key)).length;
}

/* ---------------- 红线规则引擎 ---------------- */
/* 腰痛 ≥ 7 或有腿麻（间歇/持续）→ 禁止核心训练 */
function isCoreBlocked(rec) {
  const pain = Number(rec.back.pain) || 0;
  const numb = rec.back.numb || 'none';
  return pain >= RULES.backPainHard || numb !== 'none';
}

/* 血糖等级：ok / warn / danger */
function sugarLevel(v, isFasting) {
  if (v == null || v === '') return 'ok';
  v = Number(v);
  if (isFasting) return v > RULES.fastingRed ? 'danger' : v > RULES.fastingYellow ? 'warn' : 'ok';
  return v > RULES.ppRed ? 'danger' : v > RULES.ppYellow ? 'warn' : 'ok';
}

/* 当日所有提示（顶部 alert-bar 用） */
function dayAlerts(rec) {
  const list = [];
  const fLv = sugarLevel(rec.sugar.fasting, true);
  if (fLv !== 'ok') {
    list.push({
      level: fLv,
      text: fLv === 'danger'
        ? `空腹血糖 ${rec.sugar.fasting} mmol/L 偏高（>7.0）：严格限制精制碳水与含糖饮料，尽快咨询医生。`
        : `空腹血糖 ${rec.sugar.fasting} mmol/L 已超过 6.1：进入糖尿病前期区间，请控制主食量、少精制碳水，建议 1 周内复测。`
    });
  }
  const pLv = sugarLevel(rec.sugar.postprandial, false);
  if (pLv !== 'ok') {
    list.push({
      level: pLv,
      text: `餐后血糖 ${rec.sugar.postprandial} mmol/L 偏高：餐后 30 分钟内避免久坐，主食减量、先菜后饭。`
    });
  }
  if (isCoreBlocked(rec)) {
    list.push({
      level: 'danger',
      text: Number(rec.back.pain) >= RULES.backPainHard
        ? `腰痛评分 ${rec.back.pain}（≥7）：今日已触发腰椎红线，禁止核心训练。${rec.back.numb !== 'none' ? '伴有腿麻，若持续加重请尽快就医。' : ''}`
        : '存在腿麻症状：今日已触发腰椎红线，禁止核心训练。'
    });
  }
  const hour = new Date().getHours();
  if ((rec.water || 0) < RULES.waterMin && hour >= 20) {
    list.push({ level: 'warn', text: `今日饮水仅 ${rec.water || 0}ml（<1500ml）：肾结石风险，请立即补水至 ${RULES.waterGoal}ml。` });
  }
  const v = rec.vitals || {};
  const sys = Number(v.sys), dia = Number(v.dia), hr = Number(v.hr);
  if (sys > 160 || dia > 100) {
    list.push({ level: 'danger', text: `血压 ${sys}/${dia} mmHg 明显偏高（>160/100）：静息 15 分钟后复测，如仍偏高请尽快就医。` });
  } else if (sys >= 140 || dia >= 90) {
    list.push({ level: 'warn', text: `血压 ${sys}/${dia} mmHg 偏高（≥140/90）：注意低盐饮食，连续多日偏高请咨询医生。` });
  }
  if (hr > 100) {
    list.push({ level: 'warn', text: `静息心率 ${hr} bpm 偏快（>100）：与熬夜/焦虑/咖啡因有关，持续偏快请就医。` });
  }
  return list;
}

/* ---------------- 应用状态 ---------------- */
const state = {
  view: 'today',        // today | history | settings | edit
  editDate: null,
  record: null,         // 当前编辑的记录
  openItem: null,       // （保留兼容）
  histTab: 'list',      // 历史页：list 列表 / trend 趋势
  trendRange: 30        // 趋势图时间范围（天，0 = 全部）
};

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.record.updatedAt = Date.now();
    Store.put(state.record)
      .then(() => scheduleAutoUpload())
      .catch(e => console.error('保存失败', e));
  }, 300);
}

/* ---------------- 路由 ---------------- */
function parseRoute() {
  const h = location.hash;
  if (h.startsWith('#/edit/')) return { view: 'edit', date: h.slice(7) };
  if (h.startsWith('#/')) {
    const v = h.slice(2).split('/')[0];
    if (['today', 'history', 'settings'].includes(v)) return { view: v };
  }
  return { view: 'today' };
}

async function render() {
  const r = parseRoute();
  state.view = r.view;
  state.editDate = r.date || null;
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.nav === r.view));

  const header = $('#header-date');
  header.textContent = r.view === 'edit' ? `编辑 ${r.date}` : todayKey().replace(/-/g, ' / ');

  if (r.view === 'history') { await renderHistory(); return; }
  if (r.view === 'settings') {
    state.mgTodos = null;  // 每次进入设置页重置编辑态，读取已保存配置
    renderSettings();
    return;
  }

  // today / edit 共用日视图
  const date = r.view === 'edit' ? r.date : todayKey();
  const saved = await Store.get(date);
  state.record = saved ? normalize(saved) : blankRecord(date);
  renderDayView();
}

/* ---------------- 日视图（今日 / 编辑历史） ---------------- */
/* 待办清单行 */
function todoRowHTML(rec, it) {
  const ts = todoDoneTs(rec, it.key);
  const time = ts ? new Date(ts) : null;
  const timeStr = time ? `${pad(time.getHours())}:${pad(time.getMinutes())}` : '';
  return `
    <label class="todo-row ${ts ? 'done' : ''}" data-key="${it.key}">
      <input type="checkbox" data-act="todo-toggle" data-key="${it.key}" ${ts ? 'checked' : ''}>
      <span class="todo-name">${esc(it.name)}</span>
      <span class="todo-time">${timeStr}</span>
    </label>`;
}

function renderDayView() {
  const rec = state.record;
  const isEdit = state.view === 'edit';
  const fLv = sugarLevel(rec.sugar.fasting, true);
  const pLv = sugarLevel(rec.sugar.postprandial, false);
  const fCls = fLv === 'danger' ? 'danger-v' : fLv === 'warn' ? 'warn-v' : '';
  const pCls = pLv === 'danger' ? 'danger-v' : pLv === 'warn' ? 'warn-v' : '';
  const fValCls = fLv === 'danger' ? 'danger' : fLv === 'warn' ? 'warn' : '';
  const pValCls = pLv === 'danger' ? 'danger' : pLv === 'warn' ? 'warn' : '';
  const waterPct = Math.min(100, Math.round((rec.water || 0) / RULES.waterGoal * 100));
  const pain = rec.back.pain == null ? null : Number(rec.back.pain);
  const painCls = pain >= 7 ? 'danger' : pain >= 4 ? 'warn' : '';
  const sys = Number(rec.vitals.sys), dia = Number(rec.vitals.dia), hr = Number(rec.vitals.hr);
  const bpCls = (sys > 160 || dia > 100) ? 'danger-v' : (sys >= 140 || dia >= 90) ? 'warn-v' : '';
  const hrCls = hr > 100 ? 'warn-v' : '';

  const alerts = dayAlerts(rec).map(a =>
    `<div class="alert-bar ${a.level === 'danger' ? 'danger' : 'warn'}">${esc(a.text)}</div>`).join('');

  /* 待办清单渲染 */
  const todoRows = TODO_ITEMS.map(it => todoRowHTML(rec, it)).join('');

  $('#app').innerHTML = `
    ${isEdit ? `<div class="date-edit-bar"><span>正在编辑历史记录：${esc(rec.date)}</span>
      <a href="#/today" style="color:inherit">返回今日</a></div>` : ''}
    <div class="date-edit-bar sync-bar">
      <span>云端同步：${esc(syncStatusText())}</span>
      <span>${APP_VERSION}</span>
    </div>
    ${alerts}

    <div class="metrics">
      <div class="metric-card span2">
        <div class="metric-label">血糖 mmol/L</div>
        <div class="sugar-row">
          <label>空腹<input type="number" step="0.1" min="0" class="${fCls}" data-bind="sugar.fasting"
            value="${rec.sugar.fasting ?? ''}" placeholder="如 6.2"></label>
          <label>餐后 2h<input type="number" step="0.1" min="0" class="${pCls}" data-bind="sugar.postprandial"
            value="${rec.sugar.postprandial ?? ''}" placeholder="如 8.5"></label>
        </div>
        <div class="metric-hint" style="margin-top:6px">空腹 >6.1 黄色 / >7.0 红色；餐后 >7.8 黄色 / >11.1 红色</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">饮水</div>
        <div class="metric-value">${rec.water ?? 0}<small>/ ${RULES.waterGoal}ml</small></div>
        <div class="water-bar"><div style="width:${waterPct}%"></div></div>
        <div class="water-quick">
          <button data-act="water" data-ml="250">+250</button>
          <button data-act="water" data-ml="500">+500</button>
        </div>
        <div class="form-row"><input type="number" min="0" data-bind="water" value="${rec.water ?? ''}" placeholder="手动输入 ml"></div>
      </div>
      <div class="metric-card">
        <div class="metric-label">腰痛评分（0-10）</div>
        <div class="metric-value ${painCls}">${pain == null ? '-' : pain}</div>
        <input type="range" min="0" max="10" step="1" value="${pain == null ? 0 : pain}" data-bind="back.pain">
        <div class="pain-scale"><span>0 无痛</span><span>5 中度</span><span>10 剧痛</span></div>
        <div class="form-col">
          <label>腿麻情况</label>
          <select data-bind="back.numb">
            <option value="none" ${rec.back.numb === 'none' ? 'selected' : ''}>无</option>
            <option value="intermittent" ${rec.back.numb === 'intermittent' ? 'selected' : ''}>间歇性</option>
            <option value="persistent" ${rec.back.numb === 'persistent' ? 'selected' : ''}>持续性</option>
          </select>
        </div>
      </div>
      <div class="metric-card span2">
        <div class="metric-label">膝盖痛（0-10）</div>
        <div class="metric-value">${rec.knee.pain == null ? '-' : rec.knee.pain}</div>
        <input type="range" min="0" max="10" step="1" value="${rec.knee.pain == null ? 0 : rec.knee.pain}" data-bind="knee.pain">
      </div>
      <div class="metric-card span2">
        <div class="metric-label">体重 / 血压 / 心率</div>
        <div class="sugar-row">
          <label>体重 kg<input type="number" step="0.1" min="0" data-bind="vitals.weight" value="${rec.vitals.weight ?? ''}" placeholder="如 76.0"></label>
          <label>收缩压<input type="number" min="0" class="${bpCls}" data-bind="vitals.sys" value="${rec.vitals.sys ?? ''}" placeholder="高压"></label>
          <label>舒张压<input type="number" min="0" class="${bpCls}" data-bind="vitals.dia" value="${rec.vitals.dia ?? ''}" placeholder="低压"></label>
          <label>心率 bpm<input type="number" min="0" class="${hrCls}" data-bind="vitals.hr" value="${rec.vitals.hr ?? ''}" placeholder="如 72"></label>
        </div>
        <div class="metric-hint" style="margin-top:6px">血压 ≥140/90 黄色 / >160/100 红色；静息心率 >100 黄色。建议晨起空腹测量</div>
      </div>
    </div>

    <div class="timeline-title">今日待办
      <span class="plan-count">${todoDoneCount(rec)}/${TODO_ITEMS.length}</span>
    </div>
    <div class="card combined-card">${todoRows}</div>
  `;
}

/* ---------------- 事件绑定（事件委托，全局一次） ---------------- */
function setByPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* 待办打勾 / 取消 */
function toggleTodo(key) {
  if (!state.record) return;
  if (state.record.todo && state.record.todo[key]) {
    delete state.record.todo[key];
  } else {
    if (!state.record.todo) state.record.todo = {};
    state.record.todo[key] = Date.now();
  }
  persist();
  renderDayView();
}

document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset.bind || !state.record) return;
  if (state.view === 'edit' && el.disabled) return;
  const path = el.dataset.bind;
  let val = el.value;
  if (el.type === 'number') val = val === '' ? null : Number(val);
  setByPath(state.record, path, val);

  // 血糖 / 腰痛 / 腿麻变化会影响红线提示，需重渲染（防抖内合并）
  if (/^(sugar\.|back\.)/.test(path)) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist(); renderDayView(); }, 350);
  } else {
    persist();
  }
});

document.addEventListener('change', e => {
  const el = e.target;

  /* ★ 待办打勾 */
  if (el.dataset && el.dataset.act === 'todo-toggle') {
    toggleTodo(el.dataset.key);
    return;
  }

  if (!el.dataset.bind || !state.record) return;
  setByPath(state.record, el.dataset.bind, el.value);
  if (/^(sugar\.|back\.)/.test(el.dataset.bind)) renderDayView();
  else persist();
});

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t || !state.record) return;
  const act = t.dataset.act;

  if (act === 'water') {
    state.record.water = (Number(state.record.water) || 0) + Number(t.dataset.ml);
    persist();
    renderDayView();
    return;
  }
});

/* ---------------- 历史视图 ---------------- */
/* 通用 SVG 图表：dates 升序；series [{ name, color, values }]；opts { min, max, marks, bars } */
function chartSVG(dates, series, opts = {}) {
  const vals = series.flatMap(s => s.values.filter(v => v != null && !isNaN(v)));
  if (!vals.length) return '<div class="trend-empty">这段时间还没有数据</div>';

  const W = 340, H = 158, padL = 40, padR = 12, padT = 12, padB = 20;
  const iw = W - padL - padR, ih = H - padT - padB;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  if (opts.min != null) lo = opts.min;
  if (opts.max != null) hi = opts.max;

  const N = dates.length;
  const X = i => padL + (N <= 1 ? iw / 2 : (i / (N - 1)) * iw);
  const Y = v => padT + ih - ((v - lo) / (hi - lo)) * ih;
  const fmt = n => String(Math.round(n * 10) / 10);

  let s = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img">`;

  /* 横向网格 + y 轴刻度 */
  for (let g = 0; g <= 2; g++) {
    const v = lo + (hi - lo) * (g / 2);
    const y = Y(v);
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>`;
    s += `<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="trend-tick">${fmt(v)}</text>`;
  }

  /* 阈值参考线 */
  (opts.marks || []).forEach(m => {
    if (m.y < lo || m.y > hi) return;
    const y = Y(m.y);
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${m.color}" stroke-width="1" stroke-dasharray="4 3" opacity=".75"/>`;
    if (m.label) s += `<text x="${W - padR}" y="${(y - 3).toFixed(1)}" text-anchor="end" class="trend-tick" fill="${m.color}">${m.label}</text>`;
  });

  /* x 轴日期：首 / 中 / 尾 */
  [0, Math.floor((N - 1) / 2), N - 1]
    .filter((v, i, a) => v >= 0 && a.indexOf(v) === i)
    .forEach(i => {
      s += `<text x="${X(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="trend-tick">${dates[i].slice(5)}</text>`;
    });

  if (opts.bars) {
    const ser = series[0];
    const bw = Math.max(3, Math.min(14, (iw / Math.max(N, 1)) * 0.6));
    ser.values.forEach((v, i) => {
      if (v == null) return;
      const y = Y(v), h = padT + ih - y;
      s += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${ser.color}" opacity=".8"><title>${dates[i].slice(5)} ${ser.name}：${v}</title></rect>`;
    });
  } else {
    series.forEach(ser => {
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          s += `<polyline points="${seg.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${ser.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        seg.forEach(p => {
          s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="${ser.color}"><title>${p[2]}</title></circle>`;
        });
        seg = [];
      };
      ser.values.forEach((v, i) => {
        if (v == null || isNaN(v)) { flush(); return; }
        seg.push([X(i), Y(v), `${dates[i].slice(5)} ${ser.name}：${v}`]);
      });
      flush();
    });
  }

  s += '</svg>';
  return s;
}

function trendLegend(items) {
  return `<span class="trend-legend">${items.map(([c, n]) =>
    `<span class="lg"><i style="background:${c}"></i>${n}</span>`).join('')}</span>`;
}

/* 趋势视图：按时间范围取记录并逐项绘图 */
function renderTrendHTML(all) {
  const asc = [...all].map(normalize).sort((a, b) => a.date.localeCompare(b.date));
  const days = Number(state.trendRange) || 0;
  const recs = days > 0 ? asc.slice(-days) : asc;
  if (!recs.length) return '<div class="empty-tip">这段时间还没有记录</div>';

  const dates = recs.map(r => r.date);

  const cards = [
    `<div class="card trend-card">
      <div class="trend-head">血糖 mmol/L ${trendLegend([['#4f8ef7', '空腹'], ['#f59e0b', '餐后2h']])}</div>
      ${chartSVG(dates, [
        { name: '空腹', color: '#4f8ef7', values: recs.map(r => (r.sugar && r.sugar.fasting != null) ? Number(r.sugar.fasting) : null) },
        { name: '餐后2h', color: '#f59e0b', values: recs.map(r => (r.sugar && r.sugar.postprandial != null) ? Number(r.sugar.postprandial) : null) }
      ], { min: 0, marks: [{ y: 7.0, color: '#ef4444', label: '空腹红线 7.0' }, { y: 11.1, color: '#ef4444', label: '餐后红线 11.1' }] })}
    </div>`,

    `<div class="card trend-card">
      <div class="trend-head">饮水 ml ${trendLegend([['#3b82f6', '每日总量']])}</div>
      ${chartSVG(dates, [
        { name: '饮水', color: '#3b82f6', values: recs.map(r => (r.water != null) ? Number(r.water) : null) }
      ], { min: 0, bars: true, marks: [{ y: RULES.waterGoal, color: '#10b981', label: `目标 ${RULES.waterGoal}` }] })}
    </div>`,

    `<div class="card trend-card">
      <div class="trend-head">腰痛 / 膝盖痛（0-10）${trendLegend([['#ef4444', '腰痛'], ['#8b5cf6', '膝盖']])}</div>
      ${chartSVG(dates, [
        { name: '腰痛', color: '#ef4444', values: recs.map(r => (r.back.pain != null && r.back.pain !== '') ? Number(r.back.pain) : null) },
        { name: '膝盖', color: '#8b5cf6', values: recs.map(r => (r.knee.pain != null && r.knee.pain !== '') ? Number(r.knee.pain) : null) }
      ], { min: 0, max: 10, marks: [{ y: 7, color: '#ef4444', label: '红线 7' }] })}
    </div>`,

    `<div class="card trend-card">
      <div class="trend-head">体重 kg ${trendLegend([['#10b981', '体重']])}</div>
      ${chartSVG(dates, [
        { name: '体重', color: '#10b981', values: recs.map(r => r.vitals && r.vitals.weight != null ? Number(r.vitals.weight) : null) }
      ], {})}
    </div>`,

    `<div class="card trend-card">
      <div class="trend-head">血压 mmHg ${trendLegend([['#ef4444', '收缩压'], ['#4f8ef7', '舒张压']])}</div>
      ${chartSVG(dates, [
        { name: '收缩压', color: '#ef4444', values: recs.map(r => r.vitals && r.vitals.sys != null ? Number(r.vitals.sys) : null) },
        { name: '舒张压', color: '#4f8ef7', values: recs.map(r => r.vitals && r.vitals.dia != null ? Number(r.vitals.dia) : null) }
      ], { min: 0, marks: [{ y: 140, color: '#f59e0b', label: '140' }, { y: 90, color: '#f59e0b', label: '90' }] })}
    </div>`,

    `<div class="card trend-card">
      <div class="trend-head">静息心率 bpm ${trendLegend([['#f59e0b', '心率']])}</div>
      ${chartSVG(dates, [
        { name: '心率', color: '#f59e0b', values: recs.map(r => r.vitals && r.vitals.hr != null ? Number(r.vitals.hr) : null) }
      ], { min: 0, marks: [{ y: 100, color: '#ef4444', label: '100' }] })}
    </div>`
  ];

  return `
    <div class="trend-toolbar">
      <select id="trend-range">
        ${[[7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天'], [0, '全部']].map(([v, l]) =>
          `<option value="${v}" ${Number(state.trendRange) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="hint-inline">共 ${recs.length} 天记录</span>
    </div>
    <div class="trend-list">${cards.join('')}</div>`;
}

async function renderHistory() {
  const all = (await Store.all()).sort((a, b) => b.date.localeCompare(a.date));
  if (!all.length) {
    $('#app').innerHTML = '<div class="empty-tip">还没有记录，去「今日」打卡吧</div>';
    return;
  }

  const tabs = `<div class="hist-tabs">
    <button class="tab ${state.histTab === 'list' ? 'on' : ''}" data-act="hist-tab" data-tab="list">列表</button>
    <button class="tab ${state.histTab === 'trend' ? 'on' : ''}" data-act="hist-tab" data-tab="trend">趋势</button>
  </div>`;

  if (state.histTab === 'trend') {
    $('#app').innerHTML = tabs + renderTrendHTML(all);
    return;
  }

  const rows = all.map(rec => {
    const r = normalize(rec);
    const chips = [];
    if (r.sugar.fasting != null) {
      const lv = sugarLevel(r.sugar.fasting, true);
      chips.push(`<span class="chip ${lv === 'danger' ? 'bad' : lv === 'warn' ? 'warn' : ''}">空腹 ${r.sugar.fasting}</span>`);
    }
    if (r.water != null) chips.push(`<span class="chip">饮水 ${r.water}ml</span>`);
    if (r.back.pain != null) {
      const bad = Number(r.back.pain) >= 7;
      chips.push(`<span class="chip ${bad ? 'bad' : ''}">腰痛 ${r.back.pain}</span>`);
    }
    if (r.smoke != null) chips.push(`<span class="chip">烟 ${r.smoke}支</span>`);
    const done = todoDoneCount(r);
    if (done) chips.push(`<span class="chip ${done >= TODO_ITEMS.length ? 'ok' : ''}">待办 ${done}/${TODO_ITEMS.length}</span>`);
    const vv = r.vitals || {};
    if (vv.weight != null) chips.push(`<span class="chip">体重 ${vv.weight}kg</span>`);
    if (vv.sys != null && vv.dia != null) {
      const bpBad = Number(vv.sys) > 160 || Number(vv.dia) > 100;
      const bpWarn = Number(vv.sys) >= 140 || Number(vv.dia) >= 90;
      chips.push(`<span class="chip ${bpBad ? 'bad' : bpWarn ? 'warn' : ''}">血压 ${vv.sys}/${vv.dia}</span>`);
    }
    if (vv.hr != null) chips.push(`<span class="chip">心率 ${vv.hr}</span>`);
    const blocked = isCoreBlocked(r);
    return `<div class="hist-row" data-act="open-day" data-date="${r.date}">
      <span class="hist-date">${r.date.slice(5)}</span>
      <span class="hist-chips">${chips.join('')}${blocked ? '<span class="chip bad">红线</span>' : ''}</span>
      <span class="hist-arrow">›</span>
    </div>`;
  }).join('');

  $('#app').innerHTML = tabs + rows;
}

document.addEventListener('click', e => {
  const tab = e.target.closest('[data-act="hist-tab"]');
  if (tab) {
    state.histTab = tab.dataset.tab;
    renderHistory();
    return;
  }
  const row = e.target.closest('[data-act="open-day"]');
  if (row) location.hash = `#/edit/${row.dataset.date}`;
});

document.addEventListener('change', e => {
  if (e.target.id !== 'trend-range') return;
  state.trendRange = Number(e.target.value);
  renderHistory();
});

/* ---------------- OSS 云同步（拉取合并 / 上传） ---------------- */
const APP_VERSION = 'v1.2 · build 18';

function syncStatusText() {
  if (!getOSS().putUrl) return '未配置';
  const t = Number(localStorage.getItem('oss_last_sync')) || 0;
  if (!t) return '从未同步';
  const d = new Date(t);
  return `上次同步 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getOSS() {
  /* 签名 URL 由 GitHub Actions 部署时注入（oss-config.js）；URL 存在即始终自动同步，无开关 */
  const injected = (typeof window !== 'undefined' && window.OSS_CONFIG) || {};
  return {
    putUrl: injected.putUrl || '',
    getUrl: injected.getUrl || '',
    auto: !!(injected.putUrl && injected.getUrl)
  };
}

let uploading = false;
let lastUploadAt = 0;
let uploadTimer = null;
let configAdopted = false;   // 本次拉取是否更新了打卡项配置（供界面提示/刷新）

/* 不出现在同步文件中的本机元数据键 */
const CONFIG_EXCLUDE = ['oss_last_sync', 'oss_auto', 'config_updated_at'];

/* 收集全部本机配置（自动包含今后新增的任何 localStorage 设置项） */
function configSnapshot() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (CONFIG_EXCLUDE.includes(k)) continue;
    const raw = localStorage.getItem(k);
    try { data[k] = JSON.parse(raw); } catch (e) { data[k] = raw; }
  }
  return {
    updatedAt: Number(localStorage.getItem('config_updated_at')) || 1,
    data
  };
}

/* 保存本机配置变更：打时间戳并触发自动上传 */
function markConfigChanged() {
  localStorage.setItem('config_updated_at', String(Date.now()));
  scheduleAutoUpload();
}

/* 应用云端下发的配置快照，返回是否采纳 */
function applyConfigSnapshot(cfg, force) {
  if (!cfg) return false;
  /* 兼容旧格式 { planItems, tlItems } */
  const data = cfg.data || {
    ...(Array.isArray(cfg.planItems) ? { plan_items: cfg.planItems } : {}),
    ...(Array.isArray(cfg.tlItems) ? { tl_items: cfg.tlItems } : {})
  };
  const keys = Object.keys(data || {});
  if (!keys.length) return false;
  const localTs = Number(localStorage.getItem('config_updated_at')) || 0;
  const cloudTs = Number(cfg.updatedAt) || 0;
  if (!force && cloudTs <= localTs) return false;
  keys.forEach(k => {
    if (CONFIG_EXCLUDE.includes(k)) return;
    const v = data[k];
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  });
  localStorage.setItem('config_updated_at', String(cloudTs || Date.now()));
  /* 重新装载内存中的待办定义 */
  TODO_ITEMS = loadTodoItems();
  return true;
}

/* 从云端拉取并按 updatedAt 合并到本地，返回采用的记录数 */
async function syncFromCloud() {
  const { getUrl } = getOSS();
  if (!getUrl) throw new Error('OSS 未配置');
  const res = await fetch(getUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data && data.records) || [];
  /* 先同步全部本机配置 */
  if (data && data.config) configAdopted = applyConfigSnapshot(data.config) || configAdopted;
  let adopted = 0;
  for (const raw of list) {
    if (!raw || !raw.date) continue;
    const cloud = normalize(raw);
    const local = await Store.get(cloud.date);
    if (!local || (cloud.updatedAt || 0) > (local.updatedAt || 0)) {
      await Store.put(cloud);
      adopted++;
    }
  }
  if (adopted) localStorage.setItem('oss_last_sync', String(Date.now()));
  return adopted;
}

/* 把本地全部数据上传到 OSS（整文件覆盖） */
async function syncToCloud(silent) {
  const { putUrl } = getOSS();
  if (!putUrl) { if (!silent) toast('OSS 未配置，无法上传'); return false; }
  if (uploading) return false;
  uploading = true;
  try {
    const all = await Store.all();
    const res = await fetch(putUrl, {
      method: 'PUT',
      /* 用空类型 Blob：浏览器不会自动附加 Content-Type 头，
         与签名时未含 Content-Type 的预签名 URL 完全匹配（字符串 body 会被浏览器
         自动加 text/plain 头导致 403 签名错误） */
      body: new Blob([buildExport(all)])
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localStorage.setItem('oss_last_sync', String(Date.now()));
    if (!silent) toast(`已上传 ${all.length} 条记录到 OSS`);
    return true;
  } catch (err) {
    if (!silent) {
      showModal({ title: '上传失败', danger: true, html: esc(err.message) + '<br>请检查网络后重试。' });
    }
    console.warn('OSS 上传失败', err);
    return false;
  } finally {
    uploading = false;
  }
}

/* 数据变更后自动上传：防抖 8 秒 + 最小间隔 15 秒 */
function scheduleAutoUpload() {
  const oss = getOSS();
  if (!oss.auto || !oss.putUrl) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    if (Date.now() - lastUploadAt < 15000) return;
    lastUploadAt = Date.now();
    syncToCloud(true).then(ok => { if (ok) toast('已自动同步到云端'); });
  }, 8000);
}

/* ---------------- 设置视图 ---------------- */

/* 重渲染前把输入框里未保存的名称回写到编辑态，避免丢失 */
function syncMgNamesFromDom() {
  document.querySelectorAll('.mg-name').forEach(inp => {
    const key = inp.dataset.key;
    const item = state.mgTodos && state.mgTodos.find(x => x.key === key);
    if (item) {
      const v = inp.value.trim();
      if (v) item.name = v;
    }
  });
}

function mgRowHTML(item, idx) {
  return `<div class="mg-row">
    <input type="text" class="mg-name" data-key="${item.key}" value="${esc(item.name)}">
    <span class="mg-move-group">
      <button type="button" class="mg-move" data-act="mg-move" data-idx="${idx}" data-dir="-1" title="上移">↑</button>
      <button type="button" class="mg-move" data-act="mg-move" data-idx="${idx}" data-dir="1" title="下移">↓</button>
    </span>
    <button type="button" class="mg-del" data-act="mg-del" data-idx="${idx}" title="删除">×</button>
  </div>`;
}

function renderSettings() {
  /* 仅在进入设置页时初始化编辑态，重渲染时保留未保存的改动 */
  if (!state.mgTodos) state.mgTodos = loadTodoItems();
  $('#app').innerHTML = `
    <div class="section-title">待办事项管理</div>
    <div class="card">
      <div id="mg-all">${state.mgTodos.map(mgRowHTML).join('')}</div>
      <button class="btn-block" data-act="mg-add">+ 添加待办事项</button>
      <button class="btn-block btn-primary" data-act="mg-save">保存并应用</button>
      <p class="hint">列表顺序即今日页显示顺序，用 ↑↓ 调整，「×」删除（历史记录保留）。待办事项打勾即完成，无需填写内容。</p>
    </div>

    <div class="section-title">数据备份</div>
    <div class="card">
      <button class="btn-block btn-primary" data-act="export-json">导出为 JSON 文件</button>
      <button class="btn-block" data-act="pick-import">从 JSON 文件导入恢复</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
      <p class="hint">打卡数据已自动同步到你的阿里云 OSS（打开应用自动合并云端，修改后自动上传），无需手动操作。导出 JSON 是云端之外的双保险，导入时同日期记录会被覆盖。</p>
    </div>

    <div class="section-title">危险区</div>
    <div class="card">
      <button class="btn-block btn-danger" data-act="clear-data">清空全部数据</button>
      <p class="hint">应用版本 v1.1 · 数据仅存于本设备与你自己配置的云端，无任何第三方服务器。</p>
    </div>
  `;
}

/* 导出 JSON（含打卡项配置，换设备可完整恢复） */
function buildExport(all) {
  return JSON.stringify({
    app: 'health-pwa',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: configSnapshot(),
    records: all
  }, null, 2);
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;

  if (act === 'export-json') {
    const all = await Store.all();
    if (!all.length) { toast('暂无数据可导出'); return; }
    const blob = new Blob([buildExport(all)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `health-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${all.length} 条记录`);
    return;
  }

  if (act === 'pick-import') { $('#import-file').click(); return; }

  /* ---- 待办事项管理 ---- */
  if (act === 'mg-add') {
    syncMgNamesFromDom();
    state.mgTodos.push({ key: 'c' + Date.now(), name: '新待办' });
    renderSettings();
    toast('已添加，改完记得点保存');
    return;
  }

  if (act === 'mg-del') {
    syncMgNamesFromDom();
    const idx = Number(t.dataset.idx);
    if (state.mgTodos.length <= 1) { toast('至少保留一项'); return; }
    state.mgTodos.splice(idx, 1);
    renderSettings();
    return;
  }

  if (act === 'mg-move') {
    syncMgNamesFromDom();
    const i = Number(t.dataset.idx);
    const j = i + Number(t.dataset.dir);
    if (j < 0 || j >= state.mgTodos.length) return;
    [state.mgTodos[i], state.mgTodos[j]] = [state.mgTodos[j], state.mgTodos[i]];
    renderSettings();
    return;
  }

  if (act === 'mg-save') {
    syncMgNamesFromDom();
    localStorage.setItem('todo_items', JSON.stringify(state.mgTodos));
    TODO_ITEMS = state.mgTodos;
    markConfigChanged();
    toast('已保存并应用，正在同步到云端');
    renderSettings();
    return;
  }

  if (act === 'clear-data') {
    showModal({
      title: '确认清空全部数据？',
      danger: true,
      html: '此操作不可撤销，建议先导出 JSON 备份。',
      buttons: [
        { label: '取消' },
        { label: '确认清空', cls: 'btn-danger', act: async () => {
          await Store.clear();
          toast('已清空');
          render();
        } }
      ]
    });
  }
});

/* 导入合并 */
async function importRecords(data) {
  const list = Array.isArray(data) ? data : (data && data.records) || [];
  let n = 0;
  for (const raw of list) {
    if (!raw || !raw.date) continue;
    await Store.put(normalize(raw));
    n++;
  }
  return n;
}

document.addEventListener('change', e => {
  if (e.target.id !== 'import-file' || !e.target.files.length) return;
  const file = e.target.files[0];
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (data && data.config) {
        applyConfigSnapshot({ ...data.config, updatedAt: Date.now() }, true);  // 导入为显式操作，强制应用配置
      }
      const n = await importRecords(data);
      toast(`已导入 ${n} 条记录`);
      render();
    } catch {
      showModal({ title: '导入失败', danger: true, html: '文件格式不正确，请使用本应用导出的 JSON 文件。' });
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ---------------- 启动 ---------------- */
window.addEventListener('hashchange', render);
render();

/* 启动时自动同步：拉取云端合并 → 若今日记录被云端更新则刷新视图 → 回传合并结果 */
(async () => {
  const oss = getOSS();
  if (!oss.auto || !oss.getUrl) return;
  toast('正在同步云端…');
  try {
    const adopted = await syncFromCloud();
    if (adopted && state.record && ['today', 'edit'].includes(state.view)) {
      const cur = state.record.date;
      const latest = await Store.get(cur);
      if (latest && (latest.updatedAt || 0) > (state.record.updatedAt || 0)) {
        state.record = normalize(latest);
        render();
      }
    }
    if (configAdopted) {
      render();
      toast('已同步最新打卡项配置');
    }
    const uploaded = await syncToCloud(true);
    if (adopted > 0) {
      toast(`已从云端合并 ${adopted} 条记录`);
    } else if (uploaded) {
      toast('已自动同步到云端');
    }
  } catch (e) {
    toast('云端同步失败，将稍后重试');
    console.warn('启动自动同步失败', e);
    setTimeout(() => scheduleAutoUpload(), 30000);
  }
})();

/* Service Worker 注册（仅 https / localhost 下生效） */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW 注册失败', err));

  /* 新版本 SW 接管页面时自动刷新一次，确保运行最新代码 */
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    swRefreshing = true;
    location.reload();
  });
}
