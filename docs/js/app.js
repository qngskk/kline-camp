/**
 * 重生之K线股王 · K线训练营 —— 主控制器
 */
import { decodeKLC, fmtDate } from './decode.js';
import { Session, BOARDS, eligibleRange, pickStartIndex } from './sim.js';
import { KChart } from './chart.js';

const $ = sel => document.getElementById(sel[0] === '#' ? sel.slice(1) : sel);
const POSITIONS = [
  { v: 1, label: '满仓' },
  { v: 0.5, label: '1/2 仓' },
  { v: 1 / 3, label: '1/3 仓' },
  { v: 0.25, label: '1/4 仓' },
];

const state = {
  stocks: [],
  loaded: false,
  cache: new Map(),
  candCache: new Map(),
  session: null,
  chart: null,
  mode: 'random',
  position: 1,
  horizon: 30,
  capital: 100000,
  fees: true,
  picked: null,
};

// ---------------------------------------------------------------- 工具
const money = x => (x < 0 ? '-' : '') + Math.abs(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const cls = x => (x > 1e-9 ? 'up' : x < -1e-9 ? 'down' : 'flat');
const posLabel = v => (POSITIONS.find(p => Math.abs(p.v - v) < 1e-6) || { label: v }).label;

function toast(msg, kind = 'info', ms = 2600) {
  let box = $('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms);
}

function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

// ---------------------------------------------------------------- 数据
async function loadIndex() {
  const res = await fetch('data/index.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('index.json 加载失败 (' + res.status + ')');
  const idx = await res.json();
  state.stocks = idx.stocks.map(([code, name, boardIdx, n, prior, iFrom, iTo]) =>
    ({ code, name, boardIdx, n, prior, iFrom, iTo }));
  state.meta = idx;
  state.loaded = true;
}

async function loadBars(code) {
  const key = code.slice(2);
  if (state.cache.has(key)) return state.cache.get(key);
  const res = await fetch('data/' + key + '.bin');
  if (!res.ok) throw new Error('行情数据加载失败 ' + key + ' (' + res.status + ')');
  const bars = decodeKLC(await res.arrayBuffer());
  state.cache.set(key, bars);
  return bars;
}

/** 按 horizon 建可抽样本表（含累计权重） */
function candidatesFor(horizon) {
  if (state.candCache.has(horizon)) return state.candCache.get(horizon);
  const list = [];
  let total = 0;
  for (const s of state.stocks) {
    const r = eligibleRange(s, horizon);
    if (!r) continue;
    const w = r.hi - r.lo + 1;
    list.push({ s, lo: r.lo, hi: r.hi, w, cum: total + w });
    total += w;
  }
  const out = { list, total };
  state.candCache.set(horizon, out);
  return out;
}

function weightedPick(cands) {
  const x = Math.random() * cands.total;
  let lo = 0, hi = cands.list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cands.list[mid].cum <= x) lo = mid + 1; else hi = mid;
  }
  return cands.list[lo];
}

// ---------------------------------------------------------------- 开局
async function startSession() {
  const horizon = state.horizon;
  const cands = candidatesFor(horizon);
  if (!cands.total) { setupError('本地数据里没有满足条件的样本'); return; }
  $('btn-start').disabled = true;
  $('btn-start').textContent = '加载中…';
  try {
    let pick = null;
    if (state.mode === 'pick') {
      const s = resolvePick();
      if (!s) { setupError('没找到这只股票，请从下拉建议里选一个'); return; }
      const r = eligibleRange(s, horizon);
      if (!r) { setupError('该股票没有满足条件的随机日期（可能长期停牌或上市太晚）'); return; }
      const bars = await loadBars(s.code);
      const start = pickStartIndex(bars, r.lo, r.hi, horizon);
      if (start < 0) { setupError('该股票在候选区间内长期停牌，换一只试试'); return; }
      pick = { s, bars, start };
    } else {
      for (let k = 0; k < 15 && !pick; k++) {
        const c = weightedPick(cands);
        const bars = await loadBars(c.s.code);
        const start = pickStartIndex(bars, c.lo, c.hi, horizon);
        if (start >= 0) pick = { s: c.s, bars, start };
      }
      if (!pick) { setupError('抽样失败，请重试'); return; }
    }

    state.session = new Session({
      bars: pick.bars,
      stock: { code: pick.s.code, name: pick.s.name, boardIdx: pick.s.boardIdx },
      startIdx: pick.start,
      horizon,
      position: state.position,
      capital: state.capital,
      fees: state.fees,
    });

    hide('#modal-setup');
    setupError('');
    renderAll(true);
    toast(`开始训练：${horizon} 个交易日，${posLabel(state.position)}`, 'info', 2200);
  } catch (e) {
    setupError(e.message || String(e));
  } finally {
    $('btn-start').disabled = false;
    $('btn-start').textContent = '开始训练';
  }
}

function setupError(msg) { $('setup-err').textContent = msg || ''; }

function resolvePick() {
  const raw = $('pick-input').value.trim();
  if (!raw) return null;
  // 从建议里点选过：输入框里还留着该代码就直接用
  if (state.picked && raw.includes(state.picked.code.slice(2))) return state.picked;
  const digits = (raw.match(/\d{6}/) || [])[0];
  if (digits) {
    const hit = state.stocks.find(x => x.code.slice(2) === digits);
    if (hit) { state.picked = hit; return hit; }
  }
  const s = state.stocks.find(x => x.name === raw)
    || state.stocks.find(x => x.name.includes(raw))
    || state.stocks.find(x => x.code.includes(raw.toLowerCase()));
  if (s) state.picked = s;
  return s || null;
}

// ---------------------------------------------------------------- 渲染
function refreshStockLabel() {
  const s = state.session;
  if (!s) { $('stock-label').textContent = '—'; return; }
  const hideName = state.mode === 'random' && !s.finished;
  $('stock-label').textContent = hideName
    ? '股票：？？？(随机模式已隐藏)'
    : `${s.stock.name} ${s.stock.code.toUpperCase()}`;
  const p = state.mode === 'random' && !s.finished ? '？？' : posLabel(state.position);
  $('period-label').textContent =
    `${s.horizon} 个交易日 · ${p} · 第 ${Math.min(s.day + 1, s.horizon)} 日`;
}

function renderAll(fit = false) {
  const s = state.session;
  if (!s) return;
  if (state.chart.bars !== s.bars) {
    state.chart.setData(s.bars, s.cur);
    fit = true;
  }

  $('hud-date').textContent = fmtDate(s.date);
  $('hud-equity').textContent = money(s.equity);
  const hr = $('hud-return');
  hr.textContent = pct(s.returnPct);
  hr.className = cls(s.returnPct);
  $('hud-progress').textContent = `${s.day} / ${s.horizon}`;

  $('pos-equity').textContent = money(s.equity);
  $('pos-cash').textContent = money(s.cash);
  $('pos-mv').textContent = money(s.marketValue);
  const pf = $('pos-float');
  pf.textContent = s.shares > 0 ? `${s.floatPnl >= 0 ? '+' : ''}${money(s.floatPnl)} (${pct(s.floatPct)})` : '—';
  pf.className = s.shares > 0 ? cls(s.floatPnl) : '';
  $('pos-shares').textContent = s.shares > 0 ? `${s.shares} 股 / ${s.avgCost.toFixed(2)}` : '空仓';
  const pr = $('pos-return');
  pr.textContent = pct(s.returnPct);
  pr.className = cls(s.returnPct);
  $('pos-bar').style.width = (s.progress * 100).toFixed(1) + '%';
  $('pos-hint').innerHTML = s.finished
    ? '本轮已结束。点「重新开始」换一局。'
    : `还需操作 <b>${s.daysLeft}</b> 个交易日；下一个交易日 <b>${fmtDate(s.nextDate)}</b>。`;
  $('act-date').textContent = fmtDate(s.date);

  const canAct = s.canAct;
  $('btn-buy').disabled = !canAct;
  $('btn-sell').disabled = !canAct || s.shares <= 0;
  $('btn-hold').disabled = !canAct;
  $('btn-end').disabled = s.finished;

  // 成交流水
  const box = $('log-list');
  if (!s.log.length) {
    box.innerHTML = '<div class="empty">还没有成交</div>';
  } else {
    box.innerHTML = s.log.slice().reverse().map(t => {
      const side = t.side === 'buy' ? '买' : t.side === 'sell' ? '卖' : '结算';
      const pnl = (t.pnl != null)
        ? `<span class="pnl ${t.pnl >= 0 ? 'pos' : 'neg'}">${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl)}</span>` : '';
      return `<div class="log-row ${t.side}"><span>${side} ${t.shares}股</span>` +
             `<span class="d">${fmtDate(t.date)} @${t.price.toFixed(2)}</span>${pnl}</div>`;
    }).join('');
  }

  refreshStockLabel();

  const chart = state.chart;
  chart.setLimit(s.cur, !fit);
  chart.setMarks(s.marks);
  chart.setCost(s.shares > 0 ? s.avgCost : null);
  if (fit) chart.autoView(s.cur, 90);
}

// ---------------------------------------------------------------- 操作
let confirmCb = null;
let confirmKind = null;

function openConfirm({ title, body, withPos = false, okText = '确定', kind = null, onOk }) {
  $('cf-title').textContent = title;
  $('cf-body').innerHTML = body;
  $('cf-pos').classList.toggle('hidden', !withPos);
  $('cf-ok').textContent = okText;
  confirmKind = kind;
  $('cf-ok').disabled = false;
  if (withPos) { setSeg('#seg-pos2', 'pos', state.position); updateBuyPreview(); }
  confirmCb = onOk;
  show('#modal-confirm');
}

function closeConfirm() { confirmCb = null; confirmKind = null; hide('#modal-confirm'); }

function selectedPos(sel) {
  const b = document.querySelector(sel + ' button.on');
  return b ? parseFloat(b.dataset.pos) : state.position;
}

function updateBuyPreview() {
  if (confirmKind !== 'buy') return;
  const s = state.session;
  if (!s) return;
  const f = selectedPos('#seg-pos2');
  const est = s.estimateBuy(f);
  const ok = est.shares > 0;
  $('cf-body').innerHTML =
    `<div><span class="k">买入仓位</span> <b>${posLabel(f)}</b>（可用资金 ${money(s.cash)} 元）</div>` +
    (ok
      ? `<div><span class="k">预估数量</span> <b>约 ${est.shares} 股</b>（按今收 ${s.price.toFixed(2)} 估算）</div>`
      : `<div style="color:#f87171">资金不足一手（100 股 ≈ ${money(s.price * 100)} 元），请调小仓位或换一局</div>`) +
    `<div class="k" style="margin-top:6px">实际成交价 = <b style="color:#fbbf24">${fmtDate(s.nextDate)} 开盘价</b>，此刻不可见。</div>`;
  $('cf-ok').disabled = !ok;
}

function doBuy() {
  const s = state.session;
  if (!s || !s.canAct) return;
  openConfirm({
    title: '确认买入',
    body: '',
    withPos: true,
    kind: 'buy',
    okText: '确定买入',
    onOk: () => {
      const frac = selectedPos('#seg-pos2');
      state.position = frac;
      const r = s.submit('buy', frac);
      if (!r.ok) { toast(r.msg, 'warn'); return false; }
      afterAdvance(r);
      return true;
    },
  });
}

function doSell() {
  const s = state.session;
  if (!s || !s.canAct || s.shares <= 0) return;
  openConfirm({
    title: '确认卖出',
    body: `<div><span class="k">卖出</span> <b>${s.shares} 股</b>（全部清仓）</div>` +
          `<div><span class="k">成本价</span> ${s.avgCost.toFixed(2)} 元 · 今收 ${s.price.toFixed(2)} 元</div>` +
          `<div class="k" style="margin-top:6px">实际成交价 = <b style="color:#fbbf24">${fmtDate(s.nextDate)} 开盘价</b>。</div>`,
    kind: 'sell',
    okText: '确定卖出',
    onOk: () => {
      const r = s.submit('sell');
      if (!r.ok) { toast(r.msg, 'warn'); return false; }
      afterAdvance(r);
      return true;
    },
  });
}

function doHold() {
  const s = state.session;
  if (!s || !s.canAct) return;
  const r = s.submit('hold');
  if (!r.ok) { toast(r.msg, 'warn'); return; }
  afterAdvance(r);
}

function doEnd() {
  const s = state.session;
  if (!s || s.finished) return;
  const msg = s.shares > 0
    ? (s.canAct ? `将以 <b>${fmtDate(s.nextDate)} 开盘价</b> 清仓并结算。`
                : '将按最后一日收盘价清仓并结算。')
    : '当前空仓，将直接按最新价结算。';
  openConfirm({
    title: '结束交易',
    body: `<div>${msg}</div><div class="k" style="margin-top:6px">结算后本轮不可继续。</div>`,
    kind: 'end',
    okText: '结束并结算',
    onOk: () => {
      const r = s.endSession();
      if (!r.ok) { toast(r.msg, 'warn'); return false; }
      afterAdvance(null);
      return true;
    },
  });
}

function afterAdvance(r) {
  const s = state.session;
  if (r && r.fill) {
    const f = r.fill;
    const what = f.side === 'buy' ? '买入' : '卖出';
    toast(`${fmtDate(f.date)} 开盘 ${what} ${f.shares} 股 @ ${f.price.toFixed(2)}` +
          (f.pnl != null ? `，本笔盈亏 ${f.pnl >= 0 ? '+' : ''}${Math.round(f.pnl)} 元` : ''),
          f.side === 'buy' ? 'buy' : 'sell', 3000);
  }
  renderAll(false);
  if (s.finished) setTimeout(showResult, 420);
}

// ---------------------------------------------------------------- 结算
function showResult() {
  const s = state.session;
  const r = s.summary();
  $('rs-stock').innerHTML = `<b>${r.name}</b> ${r.code.toUpperCase()} · ${r.board}`;
  const el = $('rs-return');
  el.textContent = pct(r.returnPct);
  el.className = 'big-return ' + (r.returnPct > 1e-9 ? 'pos' : r.returnPct < -1e-9 ? 'neg' : 'flat');
  $('rs-sub').textContent =
    `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}（${r.days} 个交易日）· ` +
    `初始 ${money(r.capital)} → 最终 ${money(r.finalEquity)}`;

  const dd = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  const rows = [
    ['买入次数', `${r.buys} 次`],
    ['平仓次数', `${r.closes} 次（${r.wins} 胜 ${r.losses} 负）`],
    ['胜率', r.winRate == null ? '—' : (r.winRate * 100).toFixed(0) + '%'],
    ['最大回撤', dd(r.maxDrawdown)],
    ['同期个股涨跌', dd(r.benchmarkPct)],
    ['跑赢个股', dd(r.returnPct - r.benchmarkPct)],
    ['已实现盈亏', `${r.realized >= 0 ? '+' : ''}${money(r.realized)} 元`],
    ['交易费用', money(r.totalFee) + ' 元'],
    ['结算方式', r.settleReason === 'horizon' ? '操作期满自动结算' : '手动结束交易'],
    ['剩余持仓', r.holding ? '有（已折算）' : '无'],
  ];
  $('rs-stats').innerHTML = rows.map(([k, v]) =>
    `<div><label>${k}</label><b class="${k === '同期个股涨跌' ? cls(r.benchmarkPct) : ''}">${v}</b></div>`).join('');
  refreshStockLabel();
  show('#modal-result');
}

// ---------------------------------------------------------------- 设置界面
function setSeg(sel, key, val) {
  document.querySelectorAll(sel + ' button').forEach(b => {
    b.classList.toggle('on', Math.abs(parseFloat(b.dataset[key]) - val) < 1e-6);
  });
}

function updatePoolHint() {
  if (!state.loaded) return;
  const c = candidatesFor(state.horizon);
  const stocks = new Set(c.list.map(x => x.s.code)).size;
  const from = state.meta.random[0], to = state.meta.random[1];
  $('pool-hint').innerHTML =
    `样本池 ${stocks} 只股票 / ${c.total.toLocaleString('zh-CN')} 个「股票+随机日期」组合 · ` +
    `随机日期范围 ${fmtDate(Math.max(from, state.meta.window[0]))} ~ ${fmtDate(to)}，` +
    `数据已前复权（${fmtDate(state.meta.window[0])} ~ ${fmtDate(state.meta.window[1])}）`;
}

function renderSuggest() {
  const q = $('pick-input').value.trim().toLowerCase();
  const box = $('pick-list');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  const hits = state.stocks.filter(s =>
    s.code.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 20);
  box.innerHTML = hits.length
    ? hits.map(s => `<button data-code="${s.code}">${s.name} <span style="color:#8b9bb4">${s.code.slice(2)}</span></button>`).join('')
    : '<div class="hint">没有匹配的股票（已剔除 ST / 次新 / 北交所）</div>';
  box.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.picked = state.stocks.find(x => x.code === b.dataset.code);
      $('pick-input').value = state.picked.name + ' ' + state.picked.code.slice(2);
      box.innerHTML = '';
    });
  });
}

// ---------------------------------------------------------------- 事件绑定
function bind() {
  document.querySelectorAll('#seg-mode button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('#seg-mode button').forEach(x => x.classList.toggle('on', x === b));
    $('pick-box').classList.toggle('hidden', state.mode !== 'pick');
  }));
  document.querySelectorAll('#seg-pos button').forEach(b => b.addEventListener('click', () => {
    state.position = parseFloat(b.dataset.pos);
    document.querySelectorAll('#seg-pos button').forEach(x => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#seg-horizon button').forEach(b => b.addEventListener('click', () => {
    state.horizon = parseInt(b.dataset.h, 10);
    document.querySelectorAll('#seg-horizon button').forEach(x => x.classList.toggle('on', x === b));
    updatePoolHint();
  }));
  document.querySelectorAll('#seg-pos2 button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#seg-pos2 button').forEach(x => x.classList.toggle('on', x === b));
    updateBuyPreview();
  }));

  $('pick-input').addEventListener('input', renderSuggest);
  $('btn-start').addEventListener('click', () => {
    state.capital = Math.max(10000, parseFloat($('inp-capital').value) || 100000);
    state.fees = $('chk-fee').checked;
    startSession();
  });

  $('btn-buy').addEventListener('click', doBuy);
  $('btn-sell').addEventListener('click', doSell);
  $('btn-hold').addEventListener('click', doHold);
  $('btn-end').addEventListener('click', doEnd);
  $('btn-restart').addEventListener('click', () => { hide('#modal-result'); show('#modal-setup'); updatePoolHint(); });
  $('btn-help').addEventListener('click', () => show('#modal-help'));
  $('help-ok').addEventListener('click', () => hide('#modal-help'));

  $('cf-cancel').addEventListener('click', closeConfirm);
  $('cf-ok').addEventListener('click', () => {
    if (confirmCb && confirmCb() !== false) closeConfirm();
  });
  $('modal-confirm').addEventListener('click', e => { if (e.target.id === 'modal-confirm') closeConfirm(); });

  $('rs-again').addEventListener('click', () => { hide('#modal-result'); show('#modal-setup'); updatePoolHint(); });
  $('rs-view').addEventListener('click', () => hide('#modal-result'));

  $('chk-ma').addEventListener('change', e => state.chart.setShowMA(e.target.checked));
  $('btn-zoom-in').addEventListener('click', () => zoomBy(0.8));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(1.25));
  $('btn-reset-view').addEventListener('click', () => {
    if (state.session) state.chart.autoView(state.session.cur, 120);
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || document.querySelector('.modal:not(.hidden)')) return;
    if (e.code === 'Space' || e.key === 'ArrowRight') { e.preventDefault(); doHold(); }
    else if (e.key === 'b' || e.key === 'B') doBuy();
    else if (e.key === 's' || e.key === 'S') doSell();
    else if (e.key === 'e' || e.key === 'E') doEnd();
  });
}

function zoomBy(k) {
  const c = state.chart;
  if (!c.bars) return;
  const count = c.viewTo - c.viewFrom + 1;
  const next = Math.max(20, Math.min(c.limit + 1, Math.round(count * k)));
  const from = Math.max(0, c.viewTo - next + 1);
  c.setView(from, from + next - 1);
  c.render();
}

// ---------------------------------------------------------------- 启动
async function init() {
  state.chart = new KChart($('chart'));
  bind();
  try {
    await loadIndex();
    $('pool-hint').textContent = '正在统计样本池…';
    updatePoolHint();
  } catch (e) {
    $('pool-hint').innerHTML = '<span style="color:#f87171">' + e.message +
      '</span>（请用 HTTP 服务打开本页，不要直接双击 html 文件）';
    $('btn-start').disabled = true;
  }
  show('#modal-setup');
}

init();
