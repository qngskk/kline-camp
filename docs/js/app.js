/**
 * 重生之K线股王 · K线训练营 —— 主控制器
 *
 * 每日流程：
 *   已揭示 bar[cur] → 反复加仓/减仓（尾盘模式即时成交；次日开盘模式进委托篮）
 *   → 点「进入下一日」揭示 bar[cur+1] → 严格模式此时按开盘价成交委托篮 → 循环
 */
import { decodeKLC, fmtDate } from './decode.js';
import { Session, BOARDS, FILL_MODES, eligibleRange, pickStartIndex } from './sim.js';
import { KChart } from './chart.js';

const $ = sel => document.getElementById(sel[0] === '#' ? sel.slice(1) : sel);
const POSITIONS = [
  { v: 1, label: '满仓' },
  { v: 0.5, label: '1/2 仓' },
  { v: 1 / 3, label: '1/3 仓' },
  { v: 0.25, label: '1/4 仓' },
];
const FILL_HINT = {
  close: '委托按<b>当日收盘价</b>成交：先进入「今日委托」篮，成交前可随时撤销，' +
         '点「进入下一日」时<b>按输入顺序</b>一次结算。',
  open: '委托按<b>次日开盘价</b>成交：先进入「今日委托」篮，成交前可随时撤销，' +
        '点「进入下一日」时<b>按输入顺序</b>一次结算。',
};

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
  fillMode: 'close',
  picked: null,
};

// ---------------------------------------------------------------- 工具
const money = x => (x < 0 ? '-' : '') + Math.abs(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const cls = x => (x > 1e-9 ? 'up' : x < -1e-9 ? 'down' : 'flat');
const posLabel = v => (POSITIONS.find(p => Math.abs(p.v - v) < 1e-6) || { label: (v * 100).toFixed(0) + '% 仓' }).label;
/** 按钮上的比例可能写成 '1/3' 这种精确分数，避免 0.3333333333 带来的取整误差 */
const parseFrac = v => {
  const t = String(v);
  if (t.includes('/')) { const [a, b] = t.split('/').map(Number); return a / b; }
  return parseFloat(t);
};
const fillLabel = v => (FILL_MODES.find(m => m.v === v) || FILL_MODES[0]).label;

function toast(msg, kind = 'info', ms = 2600) {
  let box = $('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.innerHTML = msg;
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
      fillMode: state.fillMode,
    });

    hide('#modal-setup');
    setupError('');
    renderAll(true);
    toast(`开始训练：${horizon} 个交易日 · ${posLabel(state.position)} · ${fillLabel(state.fillMode)}`,
          'info', 2400);
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
    `${s.horizon} 个交易日 · ${p} · ${s.fillModeLabel} · 第 ${Math.min(s.day + 1, s.horizon)} 日`;
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
    : `已操作 <b>${s.day}</b> / ${s.horizon} 日，还剩 <b>${s.daysLeft}</b> 日；仓位 <b>${(s.positionPct * 100).toFixed(1)}%</b>。`;

  // ---- 今日操作
  $('act-date').textContent = fmtDate(s.date);
  $('act-pos').textContent = (s.positionPct * 100).toFixed(1) + '%';
  $('act-sellable').textContent = s.sellableShares + ' 股';
  const canAct = s.canAct;
  const sellable = s.sellableShares - s.queuedSellShares;
  document.querySelectorAll('#side [data-add]').forEach(b => { b.disabled = !canAct; });
  document.querySelectorAll('#side [data-reduce]').forEach(b => { b.disabled = !canAct; });
  $('act-sellable').className = sellable <= 0 ? 'down' : '';
  $('btn-next').disabled = !canAct;
  $('btn-end').disabled = s.finished;

  const pend = $('pending-box');
  if (s.pending.length) {
    pend.classList.remove('hidden');
    $('pending-mode').textContent = s.fillMode === 'close'
      ? `按今日收盘价 ${s.price.toFixed(2)} 成交` : `按 ${fmtDate(s.nextDate)} 开盘价成交`;
    $('pending-list').innerHTML = s.pending.map((o, i) =>
      `<span class="pend ${o.side}"><b>${i + 1}</b>${o.label}<i data-cancel="${o.id}" title="撤销">×</i></span>`).join('');
    $('pending-list').querySelectorAll('[data-cancel]').forEach(el =>
      el.addEventListener('click', () => { s.cancelOrder(Number(el.dataset.cancel)); renderAll(false); }));
  } else {
    pend.classList.add('hidden');
  }

  $('act-hint').innerHTML = s.finished
    ? '本轮已结束。'
    : s.pending.length
      ? `已挂 <b>${s.pending.length}</b> 笔委托：点「进入下一日」时<b>按输入顺序</b>一次成交；` +
        `成交前都可以点标签上的 × 撤销。`
      : s.fillMode === 'close'
        ? `加仓/减仓先入委托篮（按今日收盘价 <b>${s.price.toFixed(2)}</b> 成交），定好后点「进入下一日」结算。`
        : `加仓/减仓先入委托篮（按 <b>${fmtDate(s.nextDate)} 开盘价</b>成交），定好后点「进入下一日」结算。`;

  // 成交流水
  const box = $('log-list');
  if (!s.log.length) {
    box.innerHTML = '<div class="empty">还没有成交</div>';
  } else {
    box.innerHTML = s.log.slice().reverse().map(t => {
      const side = t.side === 'buy' ? '买' : t.side === 'sell' ? '卖' : '结算';
      const pnl = (t.pnl != null)
        ? `<span class="pnl ${t.pnl >= 0 ? 'pos' : 'neg'}">${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl)}</span>` : '';
      return `<div class="log-row ${t.side}"><span>${t.label || side} ${t.shares}股</span>` +
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

function openConfirm({ title, body, okText = '确定', onOk }) {
  $('cf-title').textContent = title;
  $('cf-body').innerHTML = body;
  $('cf-ok').textContent = okText;
  $('cf-ok').disabled = false;
  confirmCb = onOk;
  show('#modal-confirm');
}

function closeConfirm() { confirmCb = null; hide('#modal-confirm'); }

/** 下单统一入口：type = add | full | reduce | clear
 *  一律只入「今日委托」篮，点「进入下一日」才统一结算；进入下一日前可随时撤销。 */
function placeOrder(type, fraction) {
  const s = state.session;
  if (!s) return;
  const r = s.order(type, fraction);
  if (!r.ok) { toast(r.msg, 'warn'); return; }
  const how = s.fillMode === 'close'
    ? `按今日收盘价 ${s.price.toFixed(2)}`
    : `按 ${fmtDate(s.nextDate)} 开盘价`;
  toast(`第 ${s.pending.length} 笔委托：<b>${r.order.label}</b>（${how}，点「进入下一日」成交）`,
        'info', 2400);
  renderAll(false);
}

function doAdd(fraction) {
  const s = state.session;
  if (!s || !s.canAct) return;
  const type = fraction >= 0.999999 ? 'full' : 'add';
  const p = s.plan(type, fraction);            // 先试算：涨跌停 / 资金不足当场说清楚
  if (!p.ok) { toast(p.msg, 'warn'); return; }
  placeOrder(type, fraction);
}

function doReduce(fraction) {
  const s = state.session;
  if (!s || !s.canAct) return;
  const type = fraction >= 0.999999 ? 'clear' : 'reduce';
  const p = s.plan(type, fraction);            // 先试算：空仓 / 无可卖 / 不足一手当场说清楚
  if (!p.ok) { toast(p.msg, 'warn'); return; }
  placeOrder(type, fraction);
}

function doNext() {
  const s = state.session;
  if (!s || !s.canAct) return;
  const r = s.nextDay();
  if (!r.ok) { toast(r.msg, 'warn'); return; }
  for (const f of r.fills) {
    toast(`${fmtDate(f.date)} 开盘 ${f.label}：${f.side === 'buy' ? '买入' : '卖出'} ${f.shares} 股 @ ${f.price.toFixed(2)}` +
          (f.pnl != null ? `，本笔盈亏 ${f.pnl >= 0 ? '+' : ''}${Math.round(f.pnl)} 元` : ''),
          f.side === 'buy' ? 'buy' : 'sell', 2800);
  }
  for (const j of r.rejects) toast(`${fmtDate(s.date)} ${j.msg}`, 'warn', 3400);
  renderAll(false);
  if (s.finished) setTimeout(showResult, 420);
}

function doEnd() {
  const s = state.session;
  if (!s || s.finished) return;
  let msg;
  if (s.shares <= 0) {
    msg = '当前空仓，将直接按最新价结算。';
  } else if (s.fillMode === 'close') {
    msg = `将按<b>当日收盘价 ${s.price.toFixed(2)}</b> 清仓并结算。`;
  } else if (s.canAct) {
    msg = `将以 <b>${fmtDate(s.nextDate)} 开盘价</b> 清仓结算。`;
  } else {
    msg = '将按最后一日收盘价清仓并结算。';
  }
  const drop = s.pending.length;
  openConfirm({
    title: '结束交易',
    body: `<div>${msg}</div>` +
          (drop ? `<div style="color:#fbbf24;margin-top:4px">今日 ${drop} 笔未成交委托会被放弃。</div>` : '') +
          `<div class="k" style="margin-top:6px">结算后本轮不可继续。</div>`,
    okText: '结束并结算',
    onOk: () => {
      const r = s.endSession();
      if (!r.ok) { toast(r.msg, 'warn'); return false; }
      renderAll(false);
      setTimeout(showResult, 320);
      return true;
    },
  });
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
    `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}（${r.days} 个交易日 · ${r.fillModeLabel}）· ` +
    `初始 ${money(r.capital)} → 最终 ${money(r.finalEquity)}`;

  const dd = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  const rows = [
    ['买入次数', `${r.buys} 次`],
    ['平仓次数', `${r.closes} 次（${r.wins} 胜 ${r.losses} 负）`],
    ['胜率', r.winRate == null ? '—' : (r.winRate * 100).toFixed(0) + '%'],
    ['最大回撤', dd(r.maxDrawdown)],
    ['本股区间涨跌 收→收', dd(r.benchmarkPct)],
    ['满仓持有 次开→收', dd(r.buyHoldPct)],
    ['跑赢满仓持有', dd(r.returnPct - r.buyHoldPct)],
    ['已实现盈亏', `${r.realized >= 0 ? '+' : ''}${money(r.realized)} 元`],
    ['交易费用', money(r.totalFee) + ' 元'],
    ['成交口径', r.fillModeLabel],
    ['结算方式', r.settleReason === 'horizon' ? '操作期满自动结算' : '手动结束交易'],
    ['剩余持仓', r.holding ? '有（已折算）' : '无'],
  ];
  $('rs-stats').innerHTML = rows.map(([k, v]) =>
    `<div><label>${k}</label><b class="${k.startsWith('本股区间') ? cls(r.benchmarkPct) : k === '满仓持有 次开→收' ? cls(r.buyHoldPct) : k === '跑赢满仓持有' ? cls(r.returnPct - r.buyHoldPct) : ''}">${v}</b></div>`).join('');

  // 把两个基准的起算点写出来，避免“同期个股”被误读成指数
  const c0 = s.bars.close[s.startIdx], o1 = s.bars.open[Math.min(s.startIdx + 1, s.bars.n - 1)];
  const c1 = s.price;
  $('rs-note').innerHTML =
    `对比基准都是<b>你训练的这只股票本身</b>（前复权、含分红），不是指数。<br>` +
    `本股区间涨跌：随机日 ${fmtDate(r.startDate)} 收盘 <b>${c0.toFixed(2)}</b> → 末日 ${fmtDate(r.endDate)} 收盘 <b>${c1.toFixed(2)}</b>；<br>` +
    `满仓持有：次日开盘 <b>${o1.toFixed(2)}</b>（你最早能买到的价格）→ 末日收盘 <b>${c1.toFixed(2)}</b>，` +
    `两者相差 ${o1 >= c0 ? '+' : ''}${((o1 / c0 - 1) * 100).toFixed(2)}% 的隔夜跳空。`;
  refreshStockLabel();
  show('#modal-result');
}


// ---------------------------------------------------------------- 成交明细
let tdFilter = 'all';

function openTrades() {
  const s = state.session;
  if (!s) return;
  const hideName = state.mode === 'random' && !s.finished;
  $('td-stock').textContent = hideName
    ? '（随机模式，结算后揭晓标的）'
    : `${s.stock.name} ${s.stock.code.toUpperCase()} · ${s.bars.dates[s.startIdx]}~${s.bars.dates[s.cur]}`;
  renderTrades();
  show('#modal-trades');
}

function tdRows() {
  const s = state.session;
  if (!s) return [];
  return s.log.filter(t => tdFilter === 'all' ? true
    : tdFilter === 'buy' ? t.side === 'buy' : t.side !== 'buy');
}

function renderTrades() {
  const s = state.session;
  if (!s) return;
  const money2 = x => x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = x => (x >= 0 ? '+' : '') + money2(x);
  const rows = tdRows();

  const head = ['#', '日期', '操作', '成交价', '股数', '成交额', '费用', '盈亏', '盈亏%',
                '成交后持仓', '成本价', '成交后总资产', '收益率'];
  const body = rows.map((t, i) => {
    const pnlCls = t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down';
    const retCls = cls(t.returnAfter);
    return `<tr class="${t.side}">` +
      `<td>${i + 1}</td>` +
      `<td>${fmtDate(t.date)}</td>` +
      `<td>${t.label || t.side}</td>` +
      `<td>${t.price.toFixed(2)}</td>` +
      `<td>${t.shares.toLocaleString('zh-CN')}</td>` +
      `<td>${money2(t.amount)}</td>` +
      `<td>${money2(t.fee)}</td>` +
      `<td class="${pnlCls}">${t.pnl == null ? '—' : sign(t.pnl)}</td>` +
      `<td class="${pnlCls}">${t.pnlPct == null ? '—' : pct(t.pnlPct)}</td>` +
      `<td>${t.sharesAfter == null ? '—' : t.sharesAfter.toLocaleString('zh-CN')}</td>` +
      `<td>${t.costAfter ? t.costAfter.toFixed(2) : '—'}</td>` +
      `<td>${t.equityAfter == null ? '—' : money2(t.equityAfter)}</td>` +
      `<td class="${retCls}">${t.returnAfter == null ? '—' : pct(t.returnAfter)}</td>` +
      `</tr>`;
  }).join('');

  $('td-table').innerHTML =
    `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body ||
      `<tr><td colspan="${head.length}" style="text-align:center;color:#8b9bb4;padding:18px">没有成交</td></tr>`}</tbody>`;

  const buys = rows.filter(t => t.side === 'buy');
  const sells = rows.filter(t => t.side !== 'buy');
  const sum = (arr, f) => arr.reduce((a, t) => a + (f(t) || 0), 0);
  $('td-count').textContent = `共 ${s.log.length} 笔，当前显示 ${rows.length} 笔`;
  $('td-foot').innerHTML = [
    `买入 <b>${buys.length}</b> 笔 / <b>${sum(buys, t => t.shares).toLocaleString('zh-CN')}</b> 股`,
    `卖出 <b>${sells.length}</b> 笔 / <b>${sum(sells, t => t.shares).toLocaleString('zh-CN')}</b> 股`,
    `成交额合计 <b>${money2(sum(s.log, t => t.amount))}</b> 元`,
    `费用合计 <b>${money2(sum(s.log, t => t.fee))}</b> 元`,
    `已实现盈亏 <b class="${cls(sum(sells, t => t.pnl))}">${sign(sum(sells, t => t.pnl))}</b> 元`,
    `最终收益率 <b class="${cls(s.returnPct)}">${pct(s.returnPct)}</b>`,
  ].map(x => `<span>${x}</span>`).join('');
}

function exportTradesCsv() {
  const s = state.session;
  if (!s) return;
  const rows = tdRows();
  const cell = v => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const head = ['序号', '日期', '方向', '操作', '成交价', '股数', '成交额', '费用', '盈亏', '盈亏%',
                '成交后持仓', '成本价', '成交后总资产', '收益率'];
  const lines = [head.join(',')];
  rows.forEach((t, i) => lines.push([
    i + 1, t.date, t.side === 'buy' ? '买入' : t.side === 'settle' ? '结算卖出' : '卖出',
    t.label || '', t.price.toFixed(2), t.shares, t.amount.toFixed(2), t.fee.toFixed(2),
    t.pnl == null ? '' : t.pnl.toFixed(2),
    t.pnlPct == null ? '' : (t.pnlPct * 100).toFixed(2) + '%',
    t.sharesAfter ?? '', t.costAfter ? t.costAfter.toFixed(2) : '',
    t.equityAfter == null ? '' : t.equityAfter.toFixed(2),
    t.returnAfter == null ? '' : (t.returnAfter * 100).toFixed(2) + '%',
  ].map(cell).join(',')));
  // "﻿" 让 Excel 正确识别 UTF-8 中文
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kline-${s.stock.code}-${s.bars.dates[s.startIdx]}-${s.bars.dates[s.cur]}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`已导出 ${rows.length} 笔成交`, 'info', 1800);
}

// ---------------------------------------------------------------- 设置界面
function updateFillHint() {
  $('fill-hint').innerHTML = FILL_HINT[state.fillMode];
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
    state.position = parseFrac(b.dataset.pos);
    document.querySelectorAll('#seg-pos button').forEach(x => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#seg-fill button').forEach(b => b.addEventListener('click', () => {
    state.fillMode = b.dataset.fill;
    document.querySelectorAll('#seg-fill button').forEach(x => x.classList.toggle('on', x === b));
    updateFillHint();
  }));
  document.querySelectorAll('#seg-horizon button').forEach(b => b.addEventListener('click', () => {
    state.horizon = parseInt(b.dataset.h, 10);
    document.querySelectorAll('#seg-horizon button').forEach(x => x.classList.toggle('on', x === b));
    updatePoolHint();
  }));

  document.querySelectorAll('#side [data-add]').forEach(b =>
    b.addEventListener('click', () => doAdd(parseFrac(b.dataset.add))));
  document.querySelectorAll('#side [data-reduce]').forEach(b =>
    b.addEventListener('click', () => doReduce(parseFrac(b.dataset.reduce))));

  $('pick-input').addEventListener('input', renderSuggest);
  $('btn-start').addEventListener('click', () => {
    state.capital = Math.max(10000, parseFloat($('inp-capital').value) || 100000);
    state.fees = $('chk-fee').checked;
    startSession();
  });

  $('btn-next').addEventListener('click', doNext);
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
  $('rs-trades').addEventListener('click', openTrades);
  $('btn-all-trades').addEventListener('click', openTrades);
  $('td-close').addEventListener('click', () => hide('#modal-trades'));
  $('td-csv').addEventListener('click', exportTradesCsv);
  $('modal-trades').addEventListener('click', e => { if (e.target.id === 'modal-trades') hide('#modal-trades'); });
  document.querySelectorAll('#seg-td button').forEach(b => b.addEventListener('click', () => {
    tdFilter = b.dataset.td;
    document.querySelectorAll('#seg-td button').forEach(x => x.classList.toggle('on', x === b));
    renderTrades();
  }));

  // 均线开关（默认开）
  $('btn-ma').addEventListener('click', () => {
    const on = !state.chart.showMA;
    state.chart.setShowMA(on);
    $('btn-ma').classList.toggle('on', on);
    toast(on ? '已显示均线 MA5 / MA10 / MA20' : '已关闭均线显示', 'info', 1600);
  });

  // 手动划线
  $('btn-draw').addEventListener('click', () => {
    const on = !state.chart.drawMode;
    state.chart.setDrawMode(on);
    $('btn-draw').classList.toggle('on', on);
    $('chart-tip').textContent = on
      ? '划线模式：在图上按住鼠标拖出一条直线，松开即完成；再点「划线」退出'
      : '滚轮缩放 · 拖拽平移 · 双击复位 · 悬停查看单根 K 线';
    if (on) toast('划线模式：按住鼠标拖出一条直线，松开即完成', 'info', 2400);
  });
  $('btn-undo-line').addEventListener('click', () => {
    if (state.chart.undoLine()) toast('已撤销上一条线', 'info', 1400);
    else toast('没有可撤销的线', 'warn', 1400);
  });
  $('btn-clear-line').addEventListener('click', () => {
    const n = state.chart.lines.length;
    state.chart.clearLines();
    toast(n ? `已清空 ${n} 条线` : '当前没有画线', n ? 'info' : 'warn', 1400);
  });
  state.chart.onLineChange = (n) => toast(`已画第 ${n} 条线`, 'info', 1400);

  $('btn-zoom-in').addEventListener('click', () => zoomBy(0.8));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(1.25));
  $('btn-reset-view').addEventListener('click', () => {
    if (state.session) state.chart.autoView(state.session.cur, 120);
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || document.querySelector('.modal:not(.hidden)')) return;
    if (e.code === 'Space' || e.key === 'ArrowRight') { e.preventDefault(); doNext(); }
    else if (e.key === 'e' || e.key === 'E') doEnd();
    else if (e.key === 'z' || e.key === 'Z') {
      const s = state.session;
      if (s && s.pending.length) { s.cancelOrder(s.pending[s.pending.length - 1].id); renderAll(false); }
    }
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
  window.__kline = state;        // 调试/自动化测试钩子：__kline.chart / __kline.session
  bind();
  updateFillHint();
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
