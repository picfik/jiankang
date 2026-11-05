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

const STOMACH_OPTS = ['好', '胀', '痛', '反酸'];

/* 时间轴项目定义（可在设置页增删改，自定义项存于 localStorage） */
const DEFAULT_TL_ITEMS = [
  { key: 'wake',        name: '起床',     type: 'time' },
  { key: 'breakfast',   name: '早餐',     type: 'meal' },
  { key: 'lunch',       name: '午餐',     type: 'meal' },
  { key: 'dinner',      name: '晚餐',     type: 'meal' },
  { key: 'snack',       name: '加餐',     type: 'meal' },
  { key: 'walk',        name: '快走',     type: 'exercise' },
  { key: 'smoke',       name: '吸烟',     type: 'smoke' },
  { key: 'sleep',       name: '睡眠',     type: 'sleep' }
];

/* 每日运动计划：动作 × 时段打卡（core:true 的动作受腰痛红线锁定，可在设置页增删改） */
const DEFAULT_PLAN_ITEMS = [
  { key: 'b8',         name: '八段锦', slots: ['morning', 'noon', 'evening'] },
  { key: 'deadbug',    name: '死虫式', slots: ['noon', 'evening'], core: true },
  { key: 'birddog',    name: '鸟狗式', slots: ['noon', 'evening'], core: true },
  { key: 'bridge',     name: '臀桥',   slots: ['noon', 'evening'], core: true },
  { key: 'pushup',     name: '俯卧撑', slots: ['noon', 'evening'] },
  { key: 'squat',      name: '深蹲',   slots: ['noon'] },
  { key: 'zhanzhuang', name: '站桩',   slots: ['evening'] }
];

function loadItems(storageKey, defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (e) { /* 忽略损坏的本地配置 */ }
  return JSON.parse(JSON.stringify(defaults));
}

let TL_ITEMS = loadItems('tl_items', DEFAULT_TL_ITEMS);
let PLAN_ITEMS = loadItems('plan_items', DEFAULT_PLAN_ITEMS);
const PLAN_SLOT_LABEL = { morning: '早', noon: '中', evening: '晚' };

function currentPlanSlot() {
  const h = new Date().getHours();
  return h < 11 ? 'morning' : h < 15 ? 'noon' : 'evening';
}

function planTotalSlots() {
  return PLAN_ITEMS.reduce((n, p) => n + p.slots.length, 0);
}

function planDoneSlots(rec) {
  return PLAN_ITEMS.reduce((n, p) =>
    n + p.slots.filter(s => rec.plan && rec.plan[p.key] && rec.plan[p.key][s]).length, 0);
}

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
    items: {},                                      // 时间轴打卡数据，按 key 存
    plan: {}                                        // 运动计划：plan[动作][时段] = 完成时间戳
  };
  PLAN_ITEMS.forEach(it => {
    rec.plan[it.key] = {};
    it.slots.forEach(s => { rec.plan[it.key][s] = null; });
  });
  TL_ITEMS.forEach(it => {
    rec.items[it.key] = it.type === 'meal'
      ? { desc: '', stomach: null, ts: null }
      : (it.type === 'time' || it.type === 'sleep') ? { ts: null, ...(it.type === 'sleep' ? {} : {}) }
      : { mins: null, ts: null };
  });
  rec.items.wake = { time: '', ts: null };
  rec.items.sleep = { bed: '', wake: '', ts: null };
  rec.items.smoke = { count: null, ts: null };
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
  out.items = { ...base.items };
  TL_ITEMS.forEach(it => { out.items[it.key] = { ...base.items[it.key], ...((rec.items || {})[it.key] || {}) }; });
  out.plan = { ...(rec.plan || {}), ...base.plan };  // 保留已删除动作的历史数据
  PLAN_ITEMS.forEach(it => {
    out.plan[it.key] = { ...base.plan[it.key], ...((rec.plan || {})[it.key] || {}) };
  });
  return out;
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
  openItem: null        // 当前展开的时间轴项 key
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
  if (r.view === 'settings') { renderSettings(); return; }

  // today / edit 共用日视图
  const date = r.view === 'edit' ? r.date : todayKey();
  const saved = await Store.get(date);
  state.record = saved ? normalize(saved) : blankRecord(date);
  state.openItem = null;
  renderDayView();
}

/* ---------------- 日视图（今日 / 编辑历史） ---------------- */
function itemSummary(rec, it) {
  const d = rec.items[it.key];
  if (!d) return '';
  switch (it.type) {
    case 'time': return d.time ? `✓ ${d.time}` : '';
    case 'meal': {
      if (!d.desc && d.stomach == null) return '';
      const s = d.stomach != null ? `胃部：${STOMACH_OPTS[d.stomach]}` : '';
      return `✓ ${esc(d.desc || '已记录')}${s ? ' · ' + s : ''}`;
    }
    case 'exercise': return d.mins ? `✓ ${d.mins} 分钟` : '';
    case 'core': return d.mins ? `✓ ${d.mins} 分钟` : '';
    case 'smoke': return d.count != null ? `✓ ${d.count} 支` : '';
    case 'custom': return d.desc ? `✓ ${esc(d.desc)}` : '';
    case 'sleep': return (d.bed && d.wake) ? `✓ ${d.bed} → ${d.wake}` : '';
    default: return '';
  }
}

function stomachSeg(key, current) {
  return `<div class="stomach-seg" data-seg="${key}">
    ${STOMACH_OPTS.map((o, i) =>
      `<button type="button" class="${current === i ? 'on' : ''}" data-idx="${i}">${o}</button>`).join('')}
  </div>`;
}

function itemBodyHTML(rec, it) {
  const d = rec.items[it.key];
  const fillBtn = `<button type="button" class="btn-fill" data-act="fill-last" data-key="${it.key}">一键填上次值</button>`;
  switch (it.type) {
    case 'time':
      return `<div class="form-row"><label>起床时间</label>
        <input type="time" data-bind="items.${it.key}.time" value="${esc(d.time)}"></div>${fillBtn}`;
    case 'meal':
      return `
        <div class="form-col"><label>吃了什么</label>
          <textarea data-bind="items.${it.key}.desc" placeholder="如：小米粥 + 鸡蛋">${esc(d.desc)}</textarea></div>
        <div class="form-col"><label>胃部感受</label>${stomachSeg(it.key, d.stomach)}</div>
        ${fillBtn}`;
    case 'exercise':
      return `<div class="form-row"><label>时长（分钟）</label>
        <input type="number" min="0" data-bind="items.${it.key}.mins" value="${d.mins ?? ''}"></div>${fillBtn}`;
    case 'core': {
      const blocked = isCoreBlocked(rec);
      return `
        ${blocked ? `<div class="redline-box">腰椎抗议，今日仅限平躺和腹式呼吸。<br>
          <span style="font-weight:400">（腰痛 ${rec.back.pain ?? 0}/10${rec.back.numb !== 'none' ? '，伴腿麻' : ''}，核心训练已锁定）</span></div>` : ''}
        <div class="form-row"><label>时长（分钟）</label>
          <input type="number" min="0" data-bind="items.${it.key}.mins" value="${d.mins ?? ''}" ${blocked ? 'disabled' : ''}></div>
        ${fillBtn}`;
    }
    case 'smoke':
      return `<div class="form-row"><label>今日支数</label>
        <input type="number" min="0" data-bind="items.${it.key}.count" value="${d.count ?? ''}"></div>${fillBtn}`;
    case 'custom':
      return `
        <div class="form-col"><label>记录内容</label>
          <textarea data-bind="items.${it.key}.desc" placeholder="${esc(it.name)}打卡记录">${esc(d.desc)}</textarea></div>
        ${fillBtn}`;
    case 'sleep':
      return `
        <div class="form-row"><label>就寝时间</label>
          <input type="time" data-bind="items.${it.key}.bed" value="${esc(d.bed)}"></div>
        <div class="form-row"><label>起床时间</label>
          <input type="time" data-bind="items.${it.key}.wake" value="${esc(d.wake)}"></div>${fillBtn}`;
    default: return '';
  }
}

function renderPlanHTML(rec) {
  const nowSlot = currentPlanSlot();
  const blocked = isCoreBlocked(rec);
  const rows = PLAN_ITEMS.map(p => {
    const st = rec.plan[p.key] || {};
    const cells = p.slots.map(s => {
      const done = !!st[s];
      const lock = p.core && blocked && !done;
      const now = s === nowSlot;
      const cls = ['slot-btn', done ? 'on' : '', now ? 'now' : '', lock ? 'lock' : ''].join(' ');
      return `<button type="button" class="${cls}" data-act="plan-toggle" data-key="${p.key}" data-slot="${s}">${PLAN_SLOT_LABEL[s]}${done ? ' ✓' : ''}</button>`;
    }).join('');
    const rowLock = p.core && blocked;
    return `<div class="plan-row ${rowLock ? 'blocked' : ''}">
      <span class="plan-name">${p.name}${rowLock ? ' <span class="plan-lock-tag">锁定</span>' : ''}</span>
      <span class="plan-cells">${cells}</span>
    </div>`;
  }).join('');
  return `
    <div class="timeline-title">运动计划 <span class="plan-count">今日 ${planDoneSlots(rec)}/${planTotalSlots()}</span></div>
    <div class="card plan-card">${rows}</div>`;
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
  const blocked = isCoreBlocked(rec);
  const sys = Number(rec.vitals.sys), dia = Number(rec.vitals.dia), hr = Number(rec.vitals.hr);
  const bpCls = (sys > 160 || dia > 100) ? 'danger-v' : (sys >= 140 || dia >= 90) ? 'warn-v' : '';
  const hrCls = hr > 100 ? 'warn-v' : '';

  const alerts = dayAlerts(rec).map(a =>
    `<div class="alert-bar ${a.level === 'danger' ? 'danger' : 'warn'}">${esc(a.text)}</div>`).join('');

  const timeline = TL_ITEMS.map(it => {
    const d = rec.items[it.key];
    const has = itemSummary(rec, it) !== '';
    const isCoreBlockedItem = it.type === 'core' && blocked;
    const cls = ['tl-item', has ? 'done' : '', isCoreBlockedItem ? 'blocked' : '',
      state.openItem === it.key ? 'open' : ''].join(' ');
    const summary = isCoreBlockedItem && !has
      ? '<span class="tl-summary bad">红线锁定 · 不可打卡</span>'
      : `<span class="tl-summary ${has ? 'ok' : ''}">${itemSummary(rec, it) || '未打卡'}</span>`;
    return `
      <div class="${cls}" data-item="${it.key}">
        <span class="tl-dot"></span>
        <div class="tl-head" data-act="toggle-item" data-key="${it.key}">
          <span class="tl-name">${it.name}</span>
          ${summary}
          <span class="tl-arrow">▶</span>
        </div>
        <div class="tl-body" ${state.openItem === it.key ? '' : 'hidden'}>
          ${itemBodyHTML(rec, it)}
        </div>
      </div>`;
  }).join('');

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

    ${renderPlanHTML(rec)}

    <div class="timeline-title">时间轴打卡</div>
    ${timeline}
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

/* 打卡内容非空时自动记时间戳 */
function markTs(rec, key) {
  const it = TL_ITEMS.find(x => x.key === key);
  const d = rec.items[key];
  if (!d || !it || d.ts) return;
  let has = false;
  switch (it.type) {
    case 'sleep':   has = !!(d.bed && d.wake); break;
    case 'time':    has = !!d.time; break;
    case 'smoke':   has = d.count != null; break;
    case 'meal':    has = !!(d.desc || d.stomach != null); break;
    case 'custom':  has = !!d.desc; break;
    default:        has = d.mins != null;
  }
  if (has) d.ts = Date.now();
}

document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset.bind || !state.record) return;
  if (state.view === 'edit' && el.disabled) return;
  const path = el.dataset.bind;
  let val = el.value;
  if (el.type === 'number') val = val === '' ? null : Number(val);
  setByPath(state.record, path, val);

  // 打卡项填写时记录时间戳
  const m = path.match(/^items\.(\w+)\./);
  if (m) markTs(state.record, m[1]);

  // 血糖 / 腰痛 / 腿麻变化会影响红线，需重渲染（防抖内合并）
  if (/^(sugar\.|back\.)/.test(path)) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist(); renderDayView(); }, 350);
  } else {
    persist();
    // 更新折叠摘要，不展开状态下轻量刷新
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset.bind || !state.record) return;
  setByPath(state.record, el.dataset.bind, el.value);
  const m = el.dataset.bind.match(/^items\.(\w+)\./);
  if (m) markTs(state.record, m[1]);
  if (/^(sugar\.|back\.)/.test(el.dataset.bind)) renderDayView();
  else persist();
});

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act], [data-seg] button');
  if (!t || !state.record) return;

  /* 胃部感受分段按钮 */
  if (t.parentElement && t.parentElement.dataset.seg) {
    const key = t.parentElement.dataset.seg;
    const idx = Number(t.dataset.idx);
    state.record.items[key].stomach = state.record.items[key].stomach === idx ? null : idx;
    markTs(state.record, key);
    persist();
    renderDayView();
    return;
  }

  const act = t.dataset.act;

  /* ★ 运动计划打卡：core 类动作受腰痛红线拦截 */
  if (act === 'plan-toggle') {
    const key = t.dataset.key, slot = t.dataset.slot;
    const item = PLAN_ITEMS.find(x => x.key === key);
    if (!item || !state.record) return;
    if (!state.record.plan[key]) state.record.plan[key] = {};
    const st = state.record.plan[key];
    if (st[slot]) { delete st[slot]; persist(); renderDayView(); return; }  // 再点一次撤销
    if (item.core && isCoreBlocked(state.record)) {
      showModal({
        title: '腰椎抗议，今日仅限平躺和腹式呼吸',
        danger: true,
        html: `当前腰痛评分 <b>${state.record.back.pain ?? 0}/10</b>${state.record.back.numb !== 'none' ? '，且伴有腿麻' : ''}。<br>
               死虫式、鸟狗式、臀桥等核心动作今日已锁定。<br>
               八段锦和站桩不受影响，可以照常练习。`,
        buttons: [{ label: '知道了', cls: 'btn-primary' }]
      });
      return;
    }
    st[slot] = Date.now();
    persist();
    renderDayView();
    return;
  }

  if (act === 'toggle-item') {
    const key = t.dataset.key;
    /* ★ 红线拦截：腰痛≥7 或有腿麻 → 核心训练打卡弹窗拦截 */
    if (key === 'core' && isCoreBlocked(state.record) && !state.record.items.core.mins) {
      showModal({
        title: '腰椎抗议，今日仅限平躺和腹式呼吸',
        danger: true,
        html: `当前腰痛评分 <b>${state.record.back.pain ?? 0}/10</b>${state.record.back.numb !== 'none' ? '，且伴有腿麻' : ''}。<br>
               为避免加重腰椎负担，今日核心训练已被锁定。<br>
               建议改为：平躺休息 10-20 分钟 + 腹式呼吸，疼痛持续或加重请及时就医。`,
        buttons: [{ label: '知道了', cls: 'btn-primary' }]
      });
      return;
    }
    state.openItem = state.openItem === key ? null : key;
    renderDayView();
    return;
  }

  if (act === 'water') {
    state.record.water = (Number(state.record.water) || 0) + Number(t.dataset.ml);
    persist();
    renderDayView();
    return;
  }

  if (act === 'fill-last') {
    const key = t.dataset.key;
    const all = (await Store.all())
      .filter(r => r.date !== state.record.date && r.items && r.items[key])
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const prev = all.find(r => {
      const d = r.items[key];
      if (!d) return false;
      const it = TL_ITEMS.find(x => x.key === key);
      return key === 'sleep' ? (d.bed && d.wake)
        : key === 'wake' ? d.time
        : key === 'smoke' ? d.count != null
        : ['breakfast', 'lunch', 'dinner', 'snack'].includes(key) ? (d.desc || d.stomach != null)
        : (it && it.type === 'custom') ? !!d.desc
        : d.mins != null;
    });
    if (!prev) { toast('没有找到上次记录'); return; }
    const src = prev.items[key];
    state.record.items[key] = JSON.parse(JSON.stringify(src));
    delete state.record.items[key].ts;
    persist();
    renderDayView();
    toast('已填入上次值');
  }
});

/* ---------------- 历史视图 ---------------- */
async function renderHistory() {
  const all = (await Store.all()).sort((a, b) => b.date.localeCompare(a.date));
  if (!all.length) {
    $('#app').innerHTML = '<div class="empty-tip">还没有记录，去「今日」打卡吧</div>';
    return;
  }
  $('#app').innerHTML = all.map(rec => {
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
    const exMin = ['walk']
      .reduce((s, k) => s + (Number(r.items[k] && r.items[k].mins) || 0), 0);
    if (exMin) chips.push(`<span class="chip">快走 ${exMin}min</span>`);
    const planDone = planDoneSlots(r);
    if (planDone) chips.push(`<span class="chip ${planDone >= planTotalSlots(r) ? 'ok' : ''}">计划 ${planDone}/${planTotalSlots(r)}</span>`);
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
}

document.addEventListener('click', e => {
  const row = e.target.closest('[data-act="open-day"]');
  if (row) location.hash = `#/edit/${row.dataset.date}`;
});

/* ---------------- OSS 云同步（拉取合并 / 上传） ---------------- */
const APP_VERSION = 'v1.1 · build 8';

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

/* 从云端拉取并按 updatedAt 合并到本地，返回采用的记录数 */
async function syncFromCloud() {
  const { getUrl } = getOSS();
  if (!getUrl) throw new Error('请先填写 GET 签名 URL');
  const res = await fetch(getUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data && data.records) || [];
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
      body: buildExport(all)
      /* 注意：预签名 URL 签名时未含 Content-Type，这里不要额外设置请求头 */
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

/* 管理界面临时编辑状态 */
function mgRowPlanHTML(item, idx) {
  const slotBtn = s =>
    `<button type="button" class="slot-btn-sm ${item.slots.includes(s) ? 'on' : ''}" data-act="mg-slot" data-idx="${idx}" data-slot="${s}">${PLAN_SLOT_LABEL[s]}</button>`;
  return `<div class="mg-row">
    <input type="text" class="mg-name" data-kind="plan" data-idx="${idx}" value="${esc(item.name)}">
    <span class="mg-ctrls">
      ${['morning', 'noon', 'evening'].map(slotBtn).join('')}
      <button type="button" class="slot-btn-sm ${item.core ? 'on' : ''}" data-act="mg-core" data-idx="${idx}" title="核心动作，腰痛红线时锁定">核心</button>
    </span>
    <button type="button" class="mg-del" data-act="mg-del" data-kind="plan" data-idx="${idx}">×</button>
  </div>`;
}

function mgRowTlHTML(item, idx) {
  const typeLabels = { time: '时间', meal: '餐食', exercise: '分钟', core: '分钟', smoke: '数值', sleep: '时间', custom: '文本' };
  return `<div class="mg-row">
    <input type="text" class="mg-name" data-kind="tl" data-idx="${idx}" value="${esc(item.name)}">
    <span class="mg-ctrls"><span class="mg-type">${typeLabels[item.type] || item.type}</span></span>
    <button type="button" class="mg-del" data-act="mg-del" data-kind="tl" data-idx="${idx}">×</button>
  </div>`;
}

function renderSettings() {
  state.mgPlan = loadItems('plan_items', DEFAULT_PLAN_ITEMS);
  state.mgTl = loadItems('tl_items', DEFAULT_TL_ITEMS);
  $('#app').innerHTML = `
    <div class="section-title">运动计划管理（动作 × 时段）</div>
    <div class="card">
      <div id="mg-plan">${state.mgPlan.map((p, i) => mgRowPlanHTML(p, i)).join('')}</div>
      <button class="btn-block" data-act="mg-add" data-kind="plan">+ 添加动作</button>
      <button class="btn-block btn-primary" data-act="mg-save" data-kind="plan">保存并应用到打卡页</button>
      <p class="hint">时段划分：早 5–11 点、中 11–15 点、晚 15 点后。勾「核心」的动作在腰痛 ≥7 或腿麻时自动锁定。「×」删除动作（历史数据保留）。</p>
    </div>

    <div class="section-title">时间轴项目管理</div>
    <div class="card">
      <div id="mg-tl">${state.mgTl.map((t, i) => mgRowTlHTML(t, i)).join('')}</div>
      <button class="btn-block" data-act="mg-add" data-kind="tl">+ 添加项目</button>
      <button class="btn-block btn-primary" data-act="mg-save" data-kind="tl">保存并应用到打卡页</button>
      <p class="hint">新添加的项目为「文本」类型，在打卡页填写文字即可完成打卡。</p>
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

/* 导出 JSON */
function buildExport(all) {
  return JSON.stringify({
    app: 'health-pwa',
    version: 1,
    exportedAt: new Date().toISOString(),
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

  /* ---- 打卡项管理（运动计划 / 时间轴）---- */
  if (act === 'mg-add') {
    if (t.dataset.kind === 'plan') {
      state.mgPlan.push({ key: 'c' + Date.now(), name: '新动作', slots: ['noon'], core: false });
    } else {
      state.mgTl.push({ key: 'c' + Date.now(), name: '新项目', type: 'custom' });
    }
    renderSettings();
    return;
  }

  if (act === 'mg-del') {
    const idx = Number(t.dataset.idx);
    const list = t.dataset.kind === 'plan' ? state.mgPlan : state.mgTl;
    if (list.length <= 1) { toast('至少保留一项'); return; }
    list.splice(idx, 1);
    renderSettings();
    return;
  }

  if (act === 'mg-slot') {
    const item = state.mgPlan[Number(t.dataset.idx)];
    const s = t.dataset.slot;
    item.slots = item.slots.includes(s) ? item.slots.filter(x => x !== s) : [...item.slots, s];
    if (!item.slots.length) item.slots = ['noon'];
    renderSettings();
    return;
  }

  if (act === 'mg-core') {
    const item = state.mgPlan[Number(t.dataset.idx)];
    item.core = !item.core;
    renderSettings();
    return;
  }

  if (act === 'mg-save') {
    const kind = t.dataset.kind;
    document.querySelectorAll(`.mg-name[data-kind="${kind}"]`).forEach(inp => {
      const idx = Number(inp.dataset.idx);
      const name = inp.value.trim();
      if (name) (kind === 'plan' ? state.mgPlan : state.mgTl)[idx].name = name;
    });
    if (kind === 'plan') {
      localStorage.setItem('plan_items', JSON.stringify(state.mgPlan));
      PLAN_ITEMS = state.mgPlan;
    } else {
      localStorage.setItem('tl_items', JSON.stringify(state.mgTl));
      TL_ITEMS = state.mgTl;
    }
    toast('已保存并应用');
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
