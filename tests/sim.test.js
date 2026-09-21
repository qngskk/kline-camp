/**
 * 交易仿真引擎测试：两种成交口径、加减仓、T+1、委托篮、费用、涨跌停、结算与账目守恒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session, eligibleRange, windowGapOk, pickStartIndex, fracLabel,
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

test('严格模式：同日多笔委托按 先卖后买 依次成交，回款可用于买入', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.order('add', 1);
  s.nextDay();                                  // 第 61 根开盘满仓买入
  const held = s.shares;
  assert.ok(held > 0);
  s.order('clear');                             // 先清仓
  s.order('add', 0.5);                          // 再买回（用清仓回款）
  const n = s.nextDay();
  assert.equal(n.fills.length, 2);
  assert.equal(n.fills[0].side, 'sell');
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
test('尾盘模式：下单立即按当日收盘价成交，且不推进日期', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  const r = s.order('add', 1);
  assert.equal(r.ok, true);
  assert.equal(r.fill.price, bars.close[60], '成交价 = 当日收盘价');
  assert.equal(s.cur, 60, '不推进');
  assert.equal(s.day, 0);
  assert.ok(s.shares > 0 && s.cash >= 0);
});

test('尾盘模式：同一天可反复加仓，仓位逐步抬高且不超过满仓', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  const trail = [];
  for (let i = 0; i < 4; i++) {
    const r = s.order('add', 0.25);
    assert.equal(r.ok, true, `第 ${i + 1} 笔加仓应成功`);
    trail.push(Number(s.positionPct.toFixed(4)));
    assert.ok(s.cash >= 0);
  }
  assert.equal(trail.length, 4);
  for (let i = 1; i < trail.length; i++) assert.ok(trail[i] > trail[i - 1], '仓位应递增');
  assert.ok(trail[3] > 0.95, `四次 1/4 加仓后应接近满仓，实际 ${trail[3]}`);
  assert.equal(s.day, 0, '整段操作仍在同一天');
});

test('尾盘模式：加仓后再减仓，仓位回落', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 1);
  s.nextDay();                       // 隔日，持仓变为可卖
  const before = s.shares;
  const r = s.order('reduce', 0.5);
  assert.equal(r.ok, true);
  assert.equal(r.fill.shares, Math.floor(before * 0.5 / LOT_SIZE) * LOT_SIZE);
  assert.equal(s.shares, before - r.fill.shares);
  assert.ok(s.positionPct < 0.6, '减半后仓位应明显下降');
});

test('尾盘模式：T+1 —— 当日买入当日不能卖', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 1);
  assert.ok(s.shares > 0);
  assert.equal(s.sellableShares, 0, '当日买入不可卖');
  const r = s.order('reduce', 0.5);
  assert.equal(r.ok, false);
  assert.equal(r.code, 't1');
  const r2 = s.order('clear');
  assert.equal(r2.ok, false, '清仓同样受 T+1 限制');
  s.nextDay();
  assert.equal(s.sellableShares, s.shares, '次日全部可卖');
  assert.equal(s.order('clear').ok, true);
});

test('尾盘模式：涨停封板买不进、跌停封板卖不出', () => {
  const bars = makeBars();
  bars.close[60] = limitUpOf(bars.close[59], 0);
  const s = closeSession(bars);
  const r = s.order('add', 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'limitUp');

  const bars2 = makeBars();
  const s2 = closeSession(bars2);
  s2.order('add', 1);
  s2.nextDay();
  bars2.close[61] = limitDownOf(bars2.close[60], 0);
  const r2 = s2.order('clear');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'limitDown');
  assert.ok(s2.shares > 0);
});

test('尾盘模式：同一日内用旧仓反复加减（T+1 只锁当日买入）', () => {
  const bars = makeBars();
  const s = closeSession(bars, { fees: true });
  s.order('add', 0.5);               // 第 60 日尾盘建底仓
  s.nextDay();                       // 进入第 61 日，底仓可卖
  const day0 = s.day;
  const base = s.log.length;
  const path = [];
  const plan = [['reduce', 0.5], ['add', 0.5], ['reduce', 0.25], ['add', 0.25], ['full', 1]];
  for (const [t, f] of plan) {
    const r = s.order(t, f);
    assert.equal(r.ok, true, `${t} ${f} 应成功`);
    assert.ok(s.cash >= -1e-9);
    assert.ok(s.shares >= 0);
    assert.ok(Math.abs(s.equity - (s.cash + s.shares * bars.close[s.cur])) < 1e-6, '账目守恒');
    path.push(Number(s.positionPct.toFixed(3)));
  }
  assert.equal(s.day, day0, '五笔操作全部发生在同一天，日期未推进');
  assert.equal(s.log.length - base, 5, '当日新增 5 笔成交');
  assert.ok(path[0] < 0.5, '首笔减半后仓位下降');
  assert.ok(path[path.length - 1] > 0.8, '最后一笔满仓后仓位抬高');
  assert.ok(s.boughtToday > 0, '当日买入的股票被 T+1 锁住');
  assert.equal(s.sellableShares, s.shares - s.boughtToday, '可卖 = 总持仓 − 当日买入');
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

test('结束交易：尾盘模式按当收即时清仓', () => {
  const bars = makeBars();
  const s = closeSession(bars);
  s.order('add', 1);
  const r = s.endSession();
  assert.equal(r.ok, true);
  assert.equal(s.finished, true);
  assert.equal(s.settleReason, 'manual');
  const sell = s.log.find(t => t.side === 'settle');
  assert.equal(sell.price, bars.close[60], '按当日收盘价结算');
  assert.equal(s.day, 0, '不推进日期');
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

test('费用会真实侵蚀收益', () => {
  const bars = makeBars();
  const a = closeSession(bars, { fees: false });
  const b = closeSession(bars, { fees: true });
  for (const s of [a, b]) { s.order('add', 1); for (let i = 0; i < 30; i++) s.nextDay(); }
  assert.ok(b.totalFee > 0);
  assert.ok(b.equity < a.equity, '计费后收益应更低');
  assert.equal(a.totalFee, 0);
});
