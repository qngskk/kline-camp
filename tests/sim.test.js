/**
 * 交易仿真引擎测试：两种成交口径、加减仓、T+1、委托篮、费用、涨跌停、结算与账目守恒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session, eligibleRange, windowGapOk, pickStartIndex, fracLabel,
  switchFilterOk, switchFilterDetail, SWITCH_FILTER,
  buyCost, sellProceeds, limitUpOf, limitDownOf, round2,
  PRE_BARS, MIN_LISTED, LOT_SIZE, FEE,
} from '../docs/js/sim.js';

// ---------------------------------------------------------------- 造数据
function makeBars(n = 220, { price0 = 10, seed = 12345, start = 20240102, gapAt = -1, gapDays = 0 } = {}) {
  let st = seed >>> 0;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dates = new Int32Array(n), open = new Float64Array(n), high = new Float64Array(n),
        low = new Float64Array(n), close = new Float64Array(n), vol = new Float64Array(n);
  let d = start, px = price0;
  for (let i = 0; i < n; i++) {
    if (i) {
      d = addDays(d, 1 + Math.floor(rnd() * 3) + (i === gapAt ? gapDays : 0));
    }
    dates[i] = d;
    const prev = px;
    px = prev * (1 + (rnd() - 0.5) * 0.03);          // 日波动 ±1.5%，不会触发涨跌停
    const o = prev * (1 + (rnd() - 0.5) * 0.006);
    close[i] = round2(px);
    open[i] = round2(o);
    high[i] = round2(Math.max(o, px) * (1 + rnd() * 0.01));
    low[i] = round2(Math.min(o, px) * (1 - rnd() * 0.01));
    vol[i] = 1e6 + Math.floor(rnd() * 1e6);
  }
  return { n, dates, open, high, low, close, vol };
}

function addDays(ymd, n) {
  const y = Math.floor(ymd / 10000), m = Math.floor((ymd % 10000) / 100), dd = ymd % 100;
  const t = Date.UTC(y, m - 1, dd) + n * 86400000;
  const dt = new Date(t);
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}

const STOCK = { code: 'sh600000', name: '测试股', boardIdx: 0 };
/** 默认严格模式（次日开盘成交），便于与旧行为对照 */
const newSession = (bars, o = {}) => new Session({
  bars, stock: STOCK, startIdx: 60, horizon: 30, position: 1, capital: 100000,
  fees: false, fillMode: 'open', ...o,
});
const closeSession = (bars, o = {}) => newSession(bars, { fillMode: 'close', ...o });

// ---------------------------------------------------------------- 区间与抽样
test('eligibleRange：前 3 个月 + 次新 250 日 + 后续窗口', () => {
  assert.deepEqual(eligibleRange({ n: 500, prior: 1000, iFrom: 5, iTo: 480 }, 30), { lo: 60, hi: 469 });
  assert.deepEqual(eligibleRange({ n: 500, prior: 0, iFrom: 0, iTo: 480 }, 30), { lo: 250, hi: 469 });
  assert.deepEqual(eligibleRange({ n: 500, prior: 1000, iFrom: 200, iTo: 480 }, 90), { lo: 200, hi: 409 });
  assert.equal(eligibleRange({ n: 100, prior: 0, iFrom: 0, iTo: 90 }, 30), null, '窗口不够');
  assert.equal(eligibleRange({ n: 500, prior: 0, iFrom: 0, iTo: 480 }, 500), null, 'horizon 过大');
});

test('windowGapOk：窗口内长期停牌要能识别', () => {
  const bars = makeBars(220, { gapAt: 100, gapDays: 40 });
  assert.equal(windowGapOk(bars, 60, 30), true, '停牌在窗口之外');
  assert.equal(windowGapOk(bars, 90, 30), false, '停牌落在 [30,120] 内');
  assert.equal(windowGapOk(bars, 105, 30), false, '停牌落在 [45,135] 内');
  assert.equal(windowGapOk(bars, 80, 90), false, '长窗口覆盖停牌');
});

test('pickStartIndex：只返回通过停牌检查的下标', () => {
  const bars = makeBars(220, { gapAt: 100, gapDays: 40 });
  let seed = 7;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const i = pickStartIndex(bars, 60, 150, 30, rng);
  assert.ok(i >= 60 && i <= 150);
  assert.ok(windowGapOk(bars, i, 30));
});

test('fracLabel 与费用公式', () => {
  assert.equal(fracLabel(0.25), '1/4');
  assert.equal(fracLabel(1 / 3), '1/3');
  assert.equal(fracLabel(0.5), '1/2');
  assert.equal(fracLabel(1), '满仓');
  const b = buyCost(10, 1000, true);
  assert.equal(b.gross, 10000);
  assert.equal(b.fee, 5 + 0.1);
  assert.equal(b.total, 10005.1);
  const s = sellProceeds(10, 1000, true);
  assert.equal(s.fee, 5.1);
  assert.equal(s.tax, 5);
  assert.ok(Math.abs(s.net - 9989.9) < 1e-9);
  assert.equal(buyCost(10, 1000, false).total, 10000);
  assert.equal(sellProceeds(10, 1000, false).net, 10000);
});

test('涨跌停价按板块计算', () => {
  assert.equal(limitUpOf(10, 0), 11);
  assert.equal(limitDownOf(10, 0), 9);
  assert.equal(limitUpOf(10, 1), 12);
  assert.equal(limitUpOf(10, 2), 12);
  assert.equal(limitUpOf(12.34, 0), 13.57);
});

// ---------------------------------------------------------------- 严格模式（次日开盘价）
test('严格模式：委托进篮 → 次日开盘价成交，账目守恒', () => {
  const bars = makeBars();
  const s = newSession(bars);
  const r = s.order('add', 1);
  assert.equal(r.ok, true);
  assert.equal(r.queued, true, '应进入委托篮而不是立即成交');
  assert.equal(s.pending.length, 1);
  assert.equal(s.shares, 0, '未推进前不持仓');

  const n = s.nextDay();
  assert.equal(n.ok, true);
  assert.equal(n.fills.length, 1);
  const px = bars.open[61];
  assert.equal(n.fills[0].price, px, '成交价 = 次日开盘价');
  assert.equal(n.fills[0].date, bars.dates[61]);
  const expect = Math.floor(100000 / (px * LOT_SIZE)) * LOT_SIZE;
  assert.equal(n.fills[0].shares, expect);
  assert.equal(s.cur, 61);
  assert.equal(s.day, 1);
  assert.equal(s.pending.length, 0, '成交后清空委托篮');
  assert.ok(Math.abs(s.cash - (100000 - px * expect)) < 1e-6);
  assert.ok(Math.abs(s.equity - (s.cash + expect * bars.close[61])) < 1e-6);
  assert.deepEqual(s.marks.map(m => m.idx), [61]);
});

test('严格模式：委托可撤销，撤销后不成交', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 0.5);
  const id = s.pending[0].id;
  assert.equal(s.cancelOrder(id).ok, true);
  assert.equal(s.pending.length, 0);
  const n = s.nextDay();
  assert.equal(n.fills.length, 0);
  assert.equal(s.shares, 0);
  assert.equal(s.cash, 100000);
});

test('严格模式：同日多笔同样按输入顺序成交', () => {
  const bars = makeBars();
  const s = newSession(bars);          // fillMode='open'
  s.order('add', 1);
  s.nextDay();                         // 第 61 开盘建仓
  const held = s.shares;
  assert.ok(held > 0);
  s.order('clear');                    // 第 1 笔：清仓（回款）
  s.order('add', 0.5);                 // 第 2 笔：买回
  const n = s.nextDay();
  assert.equal(n.fills.length, 2);
  assert.equal(n.fills[0].side, 'sell', '先输入的先成交');
  assert.equal(n.fills[1].side, 'buy');
  assert.equal(n.fills[0].price, bars.open[62]);
  assert.equal(n.fills[1].price, bars.open[62]);
  assert.equal(n.fills[0].shares, held);
  assert.ok(s.shares > 0, '换仓后应重新持仓');
  assert.ok(s.cash >= 0);
});

test('严格模式：同日多笔买入合并成一次满仓（受现金约束）', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 0.5);
  s.order('add', 0.5);
  const n = s.nextDay();
  assert.equal(n.fills.length, 2);
  assert.ok(s.cash >= 0, '现金不得为负');
  const total = n.fills.reduce((a, f) => a + f.shares, 0);
  assert.ok(total > 0);
  assert.ok(s.cash < bars.open[61] * LOT_SIZE * 2, '两笔加起来应基本用光现金');
});

test('严格模式：涨停开盘买不进、跌停开盘卖不出', () => {
  const bars = makeBars();
  bars.open[61] = limitUpOf(bars.close[60], 0);
  const s = newSession(bars);
  s.order('add', 1);
  const n = s.nextDay();
  assert.equal(n.fills.length, 0);
  assert.equal(n.rejects.length, 1);
  assert.equal(n.rejects[0].code, 'limitUp');
  assert.equal(s.shares, 0);
  assert.equal(s.cur, 61, '被拒也照样推进到下一日');

  const bars2 = makeBars();
  const s2 = newSession(bars2);
  s2.order('add', 1);
  s2.nextDay();
  bars2.open[62] = limitDownOf(bars2.close[61], 0);
  s2.order('clear');
  const n2 = s2.nextDay();
  assert.equal(n2.rejects[0].code, 'limitDown');
  assert.ok(s2.shares > 0, '卖不出时持仓保留');
});

// ---------------------------------------------------------------- 尾盘即时模式
test('尾盘模式：下单先进委托篮，点「进入下一日」才按今日收盘价成交', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  const r = s.order('add', 1);
  assert.equal(r.ok, true);
  assert.equal(r.queued, true, '应进委托篮而不是立刻成交');
  assert.equal(s.shares, 0, '未进入下一日前不成交');
  assert.equal(s.cash, 100000, '未进入下一日前现金不动');
  assert.equal(s.day, 0);
  assert.equal(s.pending.length, 1);

  const n = s.nextDay();
  assert.equal(n.fills.length, 1);
  assert.equal(n.fills[0].price, bars.close[60], '成交价 = 今日收盘价');
  assert.equal(n.fills[0].idx, 60, '记在提交委托的那一天');
  assert.equal(s.cur, 61);
  assert.equal(s.day, 1);
  assert.equal(s.pending.length, 0);
  assert.ok(s.shares > 0 && s.cash >= 0);
});

test('尾盘模式：同一天挂多笔加仓，按输入顺序一次成交、仓位逐步抬高', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  for (let i = 0; i < 3; i++) {
    assert.equal(s.order('add', 0.25).ok, true, `第 ${i + 1} 笔应入篮成功`);
    assert.equal(s.shares, 0);
  }
  assert.equal(s.pending.length, 3);

  const n = s.nextDay();
  assert.equal(n.fills.length, 3, '三笔都要成交');
  assert.ok(n.fills.every(f => f.price === bars.close[60]), '都按同一收盘价');
  assert.ok(n.fills.every(f => f.shares > 0));
  for (let i = 1; i < n.fills.length; i++) {
    assert.ok(n.fills[i].sharesAfter > n.fills[i - 1].sharesAfter,
      '成交明细里的持仓应逐笔递增（证明是按输入顺序算的）');
  }
  assert.ok(s.positionPct > 0.6, `三次 1/4 加仓后仓位应明显抬高，实际 ${s.positionPct}`);
  assert.ok(s.cash >= 0);
});

test('尾盘模式：已持仓时可以同批减仓，仓位回落', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 1);
  s.nextDay();                       // 隔日，持仓变为可卖
  const before = s.shares;
  assert.ok(before > 0);
  const r = s.order('reduce', 0.5);
  assert.equal(r.ok, true);
  const n = s.nextDay();
  assert.equal(n.fills.length, 1);
  assert.equal(n.fills[0].shares, Math.floor(before * 0.5 / LOT_SIZE) * LOT_SIZE);
  assert.equal(s.shares, before - n.fills[0].shares);
  assert.ok(s.positionPct < 0.6, '减半后仓位应明显下降');
});

test('尾盘模式：T+1 —— 同批买入的股票当批不能卖', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 0.5);
  s.nextDay();                        // 第 61 日持有半仓底仓
  const held = s.shares;
  assert.equal(s.sellableShares, held, '隔日全部可卖');

  s.order('add', 0.25);               // 第 61 日同批：先加仓
  s.order('clear');                   // 再清仓 → 只能卖底仓
  const n = s.nextDay();
  assert.equal(n.fills.length, 2);
  assert.equal(n.fills[0].side, 'buy');
  assert.equal(n.fills[1].side, 'sell');
  assert.equal(n.fills[1].shares, held, '清仓只卖掉底仓，当批买入的受 T+1 保护');
  assert.ok(s.shares > 0, '当批买入的还在');
  assert.equal(s.sellableShares, s.shares, '进入下一日后全部可卖');
  s.order('clear');
  const n2 = s.nextDay();
  assert.equal(s.shares, 0);
  assert.equal(n2.fills.length, 1);
});

test('尾盘模式：涨停封板买不进、跌停封板卖不出', () => {
  const bars = makeBars();
  bars.close[60] = limitUpOf(bars.close[59], 0);
  const s = closeSession(bars);
  assert.equal(s.order('add', 1).ok, true, '入篮时不判定价格');
  const n = s.nextDay();
  assert.equal(n.fills.length, 0);
  assert.equal(n.rejects.length, 1);
  assert.equal(n.rejects[0].code, 'limitUp', '按收盘价成交时才判涨停封板');
  assert.equal(s.shares, 0);

  const bars2 = makeBars();
  const s2 = closeSession(bars2);
  s2.order('add', 1);
  s2.nextDay();
  bars2.close[61] = limitDownOf(bars2.close[60], 0);
  s2.order('clear');
  const n2 = s2.nextDay();
  assert.equal(n2.rejects[0].code, 'limitDown');
  assert.ok(s2.shares > 0, '卖不出时持仓保留');
});

test('同一天多笔委托严格按输入顺序计算（顺序会改变结果）', () => {
  const bars = makeBars();
  // A：先「满仓」再「清仓」——买入先吃掉现金，清仓只能卖底仓
  const a = closeSession(bars);
  a.order('add', 0.5); a.nextDay();
  const heldA = a.shares;
  a.order('full');
  a.order('clear');
  const na = a.nextDay();
  assert.equal(na.fills.length, 2);
  assert.equal(na.fills[0].side, 'buy');
  assert.equal(na.fills[1].side, 'sell');
  assert.equal(na.fills[1].shares, heldA, '第 2 笔清仓只动了原本的底仓');

  // B：先「清仓」再「满仓」——卖出先回款，买入用这笔钱
  const b = closeSession(bars);
  b.order('add', 0.5); b.nextDay();
  b.order('clear');
  b.order('full');
  const nb = b.nextDay();
  assert.equal(nb.fills.length, 2);
  assert.equal(nb.fills[0].side, 'sell');
  assert.equal(nb.fills[1].side, 'buy');
  assert.ok(b.shares > 0, '清仓回款后能买回来');
  assert.ok(b.cash >= 0);
  assert.notEqual(a.shares, b.shares, '不同输入顺序应得到不同结果');
});

test('减仓不足一手时被拒绝，并提示用清仓', () => {
  const bars = makeBars(220, { price0: 100 });
  const s = closeSession(bars, { capital: 30000 });   // 只能买 300 股左右
  s.order('add', 1);
  s.nextDay();                                        // 隔日可卖
  const held = s.shares;
  assert.ok(held <= 300);
  const r = s.order('reduce', 0.25);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'tooSmall');
  assert.equal(s.order('clear').ok, true, '清仓应始终可用');
});

test('买不起一手时在入篮前就被拦下（两种口径）', () => {
  // 每手 1 万元：10 万本金在 100 元股价下买不起 1000 股…… 这里用 1200 元/股
  const bars = makeBars(220, { price0: 1200 });
  for (const mode of ['close', 'open']) {
    const s = closeSession(bars, { fillMode: mode, capital: 100000 });
    const r = s.order('add', 0.25);
    assert.equal(r.ok, false, `${mode} 应直接拒绝`);
    assert.equal(r.code, 'noFunds');
    assert.equal(s.pending.length, 0, '被拒的委托不应进篮');
  }
  // 资金充足时正常入篮
  const bars2 = makeBars(220, { price0: 10 });
  const s2 = closeSession(bars2);
  assert.equal(s2.order('add', 0.25).ok, true);
  assert.equal(s2.pending.length, 1);
});

test('空仓时不能减仓', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  const r = s.order('clear');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'noPosition');
});

// ---------------------------------------------------------------- 结算
test('满仓买入并持有的收益 ≈ 个股涨幅（无费用）', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 1);
  s.nextDay();
  for (let i = 0; i < 29; i++) s.nextDay();
  assert.equal(s.finished, true);
  assert.equal(s.settleReason, 'horizon');
  assert.equal(s.cur, 90);
  assert.equal(s.day, 30);
  const stockRet = bars.close[90] / bars.open[61] - 1;
  assert.ok(Math.abs(s.returnPct - stockRet) < 0.01, `组合 ${s.returnPct} vs 个股 ${stockRet}`);
});

test('操作期满自动结算，剩余持仓按最后一日收盘价折算', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 0.5);
  for (let i = 0; i < 30; i++) s.nextDay();
  assert.equal(s.finished, true);
  assert.equal(s.shares, 0, '结算后不再持仓');
  assert.equal(s.log[s.log.length - 1].side, 'settle');
  assert.equal(s.log[s.log.length - 1].price, bars.close[90]);
  assert.ok(Math.abs(s.equity - s.cash) < 1e-9);
});

test('结束交易：尾盘模式按当收清仓，并放弃未成交委托', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 0.5); s.nextDay();    // 第 60 日收盘建半仓（留出现金）
  s.order('add', 0.25);                // 挂一笔，应当被放弃
  const r = s.endSession();
  assert.equal(r.ok, true);
  assert.equal(r.drops, 1, '应报告放弃了 1 笔委托');
  assert.equal(s.finished, true);
  assert.equal(s.pending.length, 0);
  const sell = s.log.find(t => t.side === 'settle');
  assert.equal(sell.price, bars.close[61], '按当日收盘价结算');
  assert.equal(s.day, 1, '不推进日期');
});

test('结束交易：严格模式放弃委托并以次日开盘价清仓', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 1);
  s.nextDay();                       // 61 建仓
  s.order('add', 0.5);               // 挂一笔加仓，应当被放弃
  const r = s.endSession();
  assert.equal(r.ok, true);
  assert.equal(s.finished, true);
  const sell = s.log.find(t => t.side === 'sell');
  assert.equal(sell.price, bars.open[62], '清仓价 = 次日开盘价');
  assert.equal(s.day, 2);
  assert.equal(s.pending.length, 0);
  assert.equal(s.shares, 0);
});

test('结束交易：距离期满不足一日时按收盘价结算', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 1);
  s.nextDay();
  for (let i = 0; i < 28; i++) s.nextDay();   // 走到最后一日
  assert.equal(s.canAct, true);
  const r = s.endSession();
  assert.equal(r.ok, true);
  const sell = s.log.find(t => t.side === 'sell');
  assert.equal(sell.price, bars.open[90], '仍有下一日，按次日开盘价');
  assert.equal(s.finished, true);
});

// ---------------------------------------------------------------- 长程
test('长程随机操作（两种口径各 30 局）：现金不为负、账目守恒、收益率自洽', () => {
  for (const fillMode of ['close', 'open']) {
    for (let seed = 1; seed <= 30; seed++) {
      const bars = makeBars(260, { seed: seed * 977 });
      const s = new Session({
        bars, stock: STOCK, startIdx: 60, horizon: 90, position: 1,
        capital: 100000, fees: true, fillMode,
      });
      let k = 0;
      const types = ['add', 'reduce', 'clear', 'full'];
      while (!s.finished) {
        const roll = (seed * 31 + k * 17) % 10;
        if (roll < 6) s.order(types[roll % types.length], [1, 0.5, 1 / 3, 0.25][k % 4]);
        if (fillMode === 'open' && s.pending.length > 3) s.cancelOrder(s.pending[0].id);
        s.nextDay();
        assert.ok(s.cash >= -1e-6, `${fillMode} seed ${seed} 第 ${k} 步现金为负`);
        assert.ok(s.shares >= 0);
        assert.ok(s.costTotal >= -1e-6);
        assert.ok(Math.abs(s.equity - (s.cash + s.shares * bars.close[s.cur])) < 1e-5, '账目守恒');
        assert.ok(s.cur <= 60 + 90, '不得越过窗口右边界（未来数据）');
        k++;
        assert.ok(k <= 90, '不允许超过 horizon 步');
      }
      const sum = s.summary();
      assert.ok(Math.abs(sum.returnPct - (sum.finalEquity / sum.capital - 1)) < 1e-12);
      assert.ok(Math.abs(s.equity - s.cash) < 1e-9, '结算后全为现金');
      assert.ok(s.maxDrawdown <= 0);
      assert.ok(sum.totalFee >= 0);
      assert.equal(sum.fillMode, fillMode);
    }
  }
});

test('成交流水带成交后快照，且与账目自洽', () => {
  for (const mode of ['close', 'open']) {
    const bars = makeBars();
    const s = newSession(bars, { fees: true, fillMode: mode });
    s.order('add', 0.5); s.nextDay();
    s.order('add', 0.25); s.order('reduce', 0.5); s.nextDay();
    while (!s.finished) s.nextDay();

    assert.ok(s.log.length >= 4, '应有若干笔成交');
    for (const t of s.log) {
      for (const k of ['cashAfter', 'sharesAfter', 'costAfter', 'equityAfter', 'returnAfter',
                       'realizedAfter', 'feeAfter', 'positionAfter']) {
        assert.ok(t[k] != null && Number.isFinite(t[k]), `${mode} ${t.label} 缺字段 ${k}`);
      }
      // 快照内部自洽：总资产 = 现金 + 持仓 × 成交价
      assert.ok(Math.abs(t.equityAfter - (t.cashAfter + t.sharesAfter * t.price)) < 1e-6,
        `${t.label} 快照不自洽`);
      assert.ok(Math.abs(t.returnAfter - (t.equityAfter / s.capital - 1)) < 1e-12);
      assert.ok(t.shares % LOT_SIZE === 0, '成交股数应为整手');
      if (t.side === 'buy') assert.equal(t.pnl, undefined, '买入没有已实现盈亏');
      else assert.ok(Number.isFinite(t.pnl), '卖出/结算应有盈亏');
    }
    const last = s.log[s.log.length - 1];
    assert.equal(last.sharesAfter, 0, '结算后持仓应归零');
    assert.ok(Math.abs(last.equityAfter - s.summary().finalEquity) < 1e-6, '末笔总资产应等于最终总资产');
    assert.ok(Math.abs(last.returnAfter - s.returnPct) < 1e-12, '末笔收益率应等于最终收益率');
    assert.ok(Math.abs(last.feeAfter - s.totalFee) < 1e-9, '末笔累计费用应等于总费用');
  }
});

test('空仓换股：账目/已用交易日/结束日都不变，可无限次', () => {
  const bars = makeBars(220, { seed: 11 });
  const bars2 = makeBars(220, { seed: 22, price0: 20 });
  bars2.dates.set(bars.dates);                    // 让两只标的共用同一个交易日历
  const STOCK2 = { code: 'sz000001', name: '新标的', boardIdx: 1 };

  const s = closeSession(bars, { fees: true });
  s.order('add', 0.5); s.nextDay();               // 建仓
  s.order('clear'); s.nextDay();                  // 清仓 → 空仓，day=2
  const cash = s.cash, realized = s.realized, fee = s.totalFee;
  const day = s.day, endDate = s.endDate;

  const r = s.switchStock({ bars: bars2, stock: STOCK2, curIdx: s.cur });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(s.cash, cash, '现金不变');
  assert.equal(s.realized, realized, '已实现盈亏不变');
  assert.equal(s.totalFee, fee, '累计费用不变');
  assert.equal(s.day, day, '已用交易日不变');
  assert.equal(s.endDate, endDate, '结束交易日不变');
  assert.equal(s.bars, bars2, '已切到新标的');
  assert.equal(s.stock.code, 'sz000001');
  assert.equal(s.boardIdx, 1, '涨跌停口径跟着换板块');
  assert.equal(s.shares, 0);
  assert.equal(s.marks.length, 0, '旧标的的买卖标记应清空');
  assert.equal(s.switches.length, 1);

  // 可以继续在新标的上交易到结束日
  assert.equal(s.order('add', 0.5).ok, true);
  let guard = 0;
  while (!s.finished && guard++ < 200) s.nextDay();
  assert.equal(s.finished, true);
  assert.ok(Math.abs(s.equity - s.cash) < 1e-9);
  assert.equal(s.dates_end_check ?? s.bars.dates[s.cur], s.bars.dates[s.cur]);
  assert.equal(s.bars.dates[s.cur], endDate, '应在同一个结束交易日结算');
  assert.equal(s.summary().switches, 1);

  // 无限次：清仓后可以再换
  const s2 = closeSession(bars, { fees: true });
  for (let i = 0; i < 5; i++) {
    const t = i % 2 ? bars : bars2;
    const st = i % 2 ? STOCK : STOCK2;
    const rr = s2.switchStock({ bars: t, stock: st, curIdx: s2.cur });
    assert.equal(rr.ok, true, `第 ${i + 1} 次换股应成功`);
    assert.equal(rr.count, i + 1);
  }
  assert.equal(s2.switches.length, 5);
});

test('有持仓 / 已无剩余交易日 时不能换股', () => {
  const bars = makeBars(220, { seed: 11 });
  const bars2 = makeBars(220, { seed: 22 }); bars2.dates.set(bars.dates);
  const STOCK2 = { code: 'sz000001', name: '新标的', boardIdx: 1 };
  const s = closeSession(bars);
  s.order('add', 0.5); s.nextDay();
  assert.ok(s.shares > 0);
  assert.equal(s.switchStock({ bars: bars2, stock: STOCK2, curIdx: s.cur }).ok, false, '有持仓不能换');
  // 清仓后走到最后一日的次日（已无可操作交易日）
  s.order('clear'); s.nextDay();
  while (s.canAct) s.nextDay();
  assert.equal(s.switchStock({ bars: bars2, stock: STOCK2, curIdx: s.cur }).ok, false, '没剩余交易日不能换');
});

test('换股会作废旧标的的未成交委托', () => {
  const bars = makeBars(220, { seed: 11 });
  const bars2 = makeBars(220, { seed: 22 }); bars2.dates.set(bars.dates);
  const s = closeSession(bars);
  s.order('add', 0.5);
  assert.equal(s.pending.length, 1);
  s.switchStock({ bars: bars2, stock: { code: 'sz000001', name: 'X', boardIdx: 0 }, curIdx: s.cur });
  assert.equal(s.pending.length, 0, '委托篮应清空');
  assert.equal(s.shares, 0);
  const n = s.nextDay();
  assert.equal(n.fills.length, 0, '旧委托不应在新标的上成交');
});

test('换股筛选：回落 3%~15% + 连涨 2 天（用户指定条件）', () => {
  const n = 200;
  const mk = (closes) => {
    const c = new Float64Array(n).fill(10);
    closes.forEach(([i, v]) => { c[i] = v; });
    return { n, dates: new Int32Array(n).map((_, i) => 20240101 + i),
             open: c.slice(), high: c.slice(), low: c.slice(), close: c, vol: new Float64Array(n).fill(1e6) };
  };
  // ① 高点 10、最近三天 9.0→9.2→9.4（回落 6%，连涨 2 天）→ 通过
  {
    const b = mk([[69, 9.0], [70, 9.2], [71, 9.4]]);
    const d = switchFilterDetail(b, 71);
    assert.equal(d.inRange, true, `回落 ${(d.dd * 100).toFixed(1)}% 应在 [-15%,-3%]`);
    assert.equal(d.up, true, '9.2→9.4 应为连涨');
    assert.equal(switchFilterOk(b, 71), true);
  }
  // ② 只涨 1 天（9.6→9.4→9.6）→ 不通过
  {
    const b = mk([[69, 9.6], [70, 9.4], [71, 9.6]]);
    const d = switchFilterDetail(b, 71);
    assert.equal(d.inRange, true);
    assert.equal(d.up, false, '前一天是跌的，不算连涨 2 天');
    assert.equal(switchFilterOk(b, 71), false);
  }
  // ③ 离高点太近（10.2→10.3→10.4，几乎在高点）→ 不通过
  {
    const b = mk([[69, 10.2], [70, 10.3], [71, 10.4]]);
    const d = switchFilterDetail(b, 71);
    assert.equal(d.inRange, false, `回落 ${(d.dd * 100).toFixed(1)}% 不足 3%`);
    assert.equal(switchFilterOk(b, 71), false);
  }
  // ④ 回落超过 15%（8.0→8.2→8.4，高点 10）→ 不通过
  {
    const b = mk([[69, 8.0], [70, 8.2], [71, 8.4]]);
    const d = switchFilterDetail(b, 71);
    assert.ok(d.dd < -0.15, `回落 ${(d.dd * 100).toFixed(1)}% 应小于 -15%`);
    assert.equal(switchFilterOk(b, 71), false);
  }
  // ⑤ 只看近 60 日：100 天前的 30 元不算高点
  {
    const b = mk([[100, 30], [158, 10], [159, 9.0], [160, 9.2], [161, 9.4]]);
    const d = switchFilterDetail(b, 161);
    assert.ok(Math.abs(d.dd - (-0.06)) < 1e-9, `应只用近 60 日最高收盘 10，实际回落 ${(d.dd * 100).toFixed(1)}%`);
    assert.equal(switchFilterOk(b, 161), true);
  }
  // ⑥ K 线不足 60 根 → 无法判定，不通过
  {
    const b = mk([]);
    assert.equal(switchFilterDetail(b, 10).ready, false);
    assert.equal(switchFilterOk(b, 10), false);
  }
  assert.equal(SWITCH_FILTER.pullbackMin, -0.15);
  assert.equal(SWITCH_FILTER.pullbackMax, -0.03);
  assert.equal(SWITCH_FILTER.upDays, 2);
});

test('费用会真实侵蚀收益', () => {
  const bars = makeBars();
  const a = closeSession(bars, { fees: false });
  const b = closeSession(bars, { fees: true });
  for (const s of [a, b]) { s.order('add', 1); for (let i = 0; i < 30; i++) s.nextDay(); }
  assert.ok(b.totalFee > 0);
  assert.ok(b.equity < a.equity, '计费后收益应更低');
  assert.equal(a.totalFee, 0);
});
