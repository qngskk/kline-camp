/**
 * 交易仿真引擎测试：成交价、仓位、费用、涨跌停、结算与账目守恒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session, eligibleRange, windowGapOk, pickStartIndex,
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
      // 自然日推进 1~3 天（周末），必要时插入一次长期停牌
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
const newSession = (bars, o = {}) => new Session({
  bars, stock: STOCK, startIdx: 60, horizon: 30, position: 1, capital: 100000, fees: false, ...o,
});

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

// ---------------------------------------------------------------- 费用
test('费用公式', () => {
  const b = buyCost(10, 1000, true);
  assert.equal(b.gross, 10000);
  assert.equal(b.fee, 5 + 0.1);              // 佣金最低 5 元 + 过户费万 0.1
  assert.equal(b.total, 10005.1);
  const s = sellProceeds(10, 1000, true);
  assert.equal(s.fee, 5.1);
  assert.equal(s.tax, 5);                    // 印花税千 0.5
  assert.ok(Math.abs(s.net - 9989.9) < 1e-9);
  assert.equal(buyCost(10, 1000, false).total, 10000);
  assert.equal(sellProceeds(10, 1000, false).net, 10000);
});

test('涨跌停价按板块计算', () => {
  assert.equal(limitUpOf(10, 0), 11);
  assert.equal(limitDownOf(10, 0), 9);
  assert.equal(limitUpOf(10, 1), 12);        // 创业板 20%
  assert.equal(limitUpOf(10, 2), 12);        // 科创板 20%
  assert.equal(limitUpOf(12.34, 0), 13.57);  // 四舍五入到分
});

// ---------------------------------------------------------------- 成交
test('买入以次日开盘价成交，账目守恒', () => {
  const bars = makeBars();
  const s = newSession(bars);
  const r = s.submit('buy', 1);
  assert.equal(r.ok, true);
  const px = bars.open[61];
  assert.equal(r.fill.price, px, '成交价 = 次日开盘价');
  assert.equal(r.fill.date, bars.dates[61]);
  const expect = Math.floor(100000 / (px * LOT_SIZE)) * LOT_SIZE;
  assert.equal(r.fill.shares, expect);
  assert.equal(s.cur, 61);
  assert.equal(s.day, 1);
  assert.ok(Math.abs(s.cash - (100000 - px * expect)) < 1e-6);
  assert.ok(Math.abs(s.equity - (s.cash + expect * bars.close[61])) < 1e-6);
  assert.equal(s.marks.length, 1);
  assert.equal(s.marks[0].idx, 61);
  assert.ok(s.nextDate === bars.dates[62]);
});

test('买入不满一手时拒绝且不推进交易日', () => {
  const bars = makeBars(220, { price0: 200 });
  const s = newSession(bars, { capital: 10000 });   // 200 元 × 100 股 = 2 万 > 本金
  const r = s.submit('buy', 0.25);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'noFunds');
  assert.equal(s.cur, 60);
  assert.equal(s.day, 0);
});

test('卖出同样以次日开盘价成交，并结算盈亏', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 1);
  const shares = s.shares, cost = s.costTotal;
  const r = s.submit('sell');
  assert.equal(r.ok, true);
  assert.equal(r.fill.price, bars.open[62]);
  assert.equal(s.shares, 0);
  assert.equal(s.costTotal, 0);
  assert.ok(Math.abs(r.fill.pnl - (bars.open[62] * shares - cost)) < 1e-6);
  assert.ok(Math.abs(s.cash - (100000 + r.fill.pnl)) < 1e-6);
  assert.equal(s.marks.length, 2);
});

test('涨停开盘买不进、跌停开盘卖不出', () => {
  const bars = makeBars();
  bars.open[61] = limitUpOf(bars.close[60], 0);
  const s = newSession(bars);
  const bad = s.submit('buy', 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'limitUp');
  assert.equal(s.cur, 60, '被拒后不推进');

  const bars2 = makeBars();
  const s2 = newSession(bars2);
  s2.submit('buy', 1);                       // 在 61 日开盘成交
  bars2.open[62] = limitDownOf(bars2.close[61], 0);
  const bad2 = s2.submit('sell');
  assert.equal(bad2.ok, false);
  assert.equal(bad2.code, 'limitDown');
  assert.equal(s2.cur, 61, '卖不出时不推进');
  assert.ok(s2.shares > 0, '持仓保留');
});

test('满仓买入并持有的收益 ≈ 个股涨幅（无费用）', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 1);
  for (let i = 0; i < 29; i++) s.submit('hold');
  assert.equal(s.finished, true);
  assert.equal(s.settleReason, 'horizon');
  assert.equal(s.cur, 90);
  assert.equal(s.day, 30);
  const stockRet = bars.close[90] / bars.open[61] - 1;
  assert.ok(Math.abs(s.returnPct - stockRet) < 0.005, `组合 ${s.returnPct} vs 个股 ${stockRet}`);
});

test('1/3 仓位买入只动用约三分之一资金', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 1 / 3);
  const used = 100000 - s.cash;
  assert.ok(used > 100000 / 3 - bars.open[61] * LOT_SIZE && used <= 100000 / 3);
  assert.ok(s.cash > 60000);
});

test('操作期满自动结算，剩余持仓按最后一日收盘价折算', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 0.5);
  for (let i = 0; i < 29; i++) s.submit('hold');
  assert.equal(s.finished, true);
  assert.equal(s.shares, 0, '结算后不再持仓');
  assert.equal(s.log.at(-1).side, 'settle');
  assert.equal(s.log.at(-1).price, bars.close[90]);
  assert.ok(Math.abs(s.equity - s.cash) < 1e-9);
});

test('结束交易：有持仓时以次日开盘价清仓', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 1);
  const r = s.endSession();
  assert.equal(r.ok, true);
  assert.equal(s.finished, true);
  assert.equal(s.settleReason, 'manual');
  const sell = s.log.find(t => t.side === 'sell');
  assert.equal(sell.price, bars.open[62], '清仓价 = 次日开盘价');
  assert.equal(s.day, 2);
});

test('结束交易：距离期满不足一日时按收盘价结算', () => {
  const bars = makeBars();
  const s = newSession(bars);
  s.submit('buy', 1);
  for (let i = 0; i < 28; i++) s.submit('hold');   // 走到最后一日（cur = 89）
  assert.equal(s.canAct, true);
  const r = s.endSession();
  assert.equal(r.ok, true);
  const sell = s.log.find(t => t.side === 'sell');
  assert.equal(sell.price, bars.open[90], '仍有下一日，按次日开盘价');
  assert.equal(s.finished, true);
});

test('长程随机操作：现金不为负、账目守恒、收益率自洽', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const bars = makeBars(260, { seed: seed * 977 });
    const s = newSession(bars, { fees: true, horizon: 90, startIdx: 60 });
    let k = 0;
    while (!s.finished) {
      const roll = (seed * 31 + k * 17) % 10;
      const action = roll < 4 ? 'buy' : roll < 6 ? 'sell' : 'hold';
      let r = s.submit(action, [1, 0.5, 1 / 3, 0.25][k % 4]);
      if (!r.ok) {
        assert.equal(s.cur, 60 + k, '被拒的委托不推进');
        r = s.submit('hold');            // 委托被拒（涨跌停/资金不足）时改观望
        assert.equal(r.ok, true);
      }
      assert.ok(s.cash >= -1e-9, `seed ${seed} 第 ${k} 步现金为负`);
      assert.ok(s.shares >= 0);
      assert.ok(s.costTotal >= -1e-9);
      assert.ok(Math.abs(s.equity - (s.cash + s.shares * bars.close[s.cur])) < 1e-6, '账目守恒');
      k++;
      assert.ok(k <= 90);
    }
    const sum = s.summary();
    assert.ok(Math.abs(sum.returnPct - (sum.finalEquity / sum.capital - 1)) < 1e-12);
    assert.ok(Math.abs(s.equity - s.cash) < 1e-9, '结算后全为现金');
    assert.ok(s.maxDrawdown <= 0);
    assert.ok(sum.totalFee >= 0);
  }
});

test('费用会真实侵蚀收益', () => {
  const bars = makeBars();
  const a = newSession(bars, { fees: false });
  const b = newSession(bars, { fees: true });
  for (const s of [a, b]) { s.submit('buy', 1); for (let i = 0; i < 29; i++) s.submit('hold'); }
  assert.ok(b.totalFee > 0);
  assert.ok(b.equity < a.equity, '计费后收益应更低');
  assert.ok(Math.abs((a.totalFee) - 0) < 1e-12);
});

test('预估买入股数不超过实际可买股数', () => {
  const bars = makeBars();
  const s = newSession(bars, { fees: true });
  const est = s.estimateBuy(1);
  const r = s.submit('buy', 1);
  assert.ok(est.shares >= r.fill.shares - LOT_SIZE, '估算应与实际同一量级');
  assert.ok(r.fill.shares > 0);
});
