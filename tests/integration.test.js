/**
 * 端到端集成测试：直接用**真实构建产物**（docs/data）跑抽样 + 训练，
 * 验证数据、选样规则与仿真引擎三者之间的契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKLC } from '../docs/js/decode.js';
import { Session, eligibleRange, windowGapOk, PRE_BARS, LOT_SIZE, BOARDS } from '../docs/js/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const IDX = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const STOCKS = IDX.stocks.map(([code, name, boardIdx, n, prior, iFrom, iTo]) =>
  ({ code, name, boardIdx, n, prior, iFrom, iTo }));

const cache = new Map();
function bars(code) {
  const key = code.slice(2);
  if (!cache.has(key)) {
    const b = fs.readFileSync(path.join(DATA, key + '.bin'));
    cache.set(key, decodeKLC(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  return cache.get(key);
}

test('index.json 头部字段自洽', () => {
  assert.equal(IDX.v, 1);
  assert.ok(IDX.window[0] < IDX.window[1]);
  assert.ok(IDX.random[0] >= IDX.window[0] && IDX.random[1] <= IDX.window[1]);
  assert.equal(IDX.preBars, PRE_BARS);
  assert.equal(IDX.boards.length, 3);
  assert.ok(STOCKS.length > 4500);
  for (const s of STOCKS.slice(0, 200)) {
    assert.ok(s.code.startsWith('sh') || s.code.startsWith('sz'), s.code);
    assert.ok([0, 1, 2].includes(s.boardIdx));
    assert.ok(s.n > 0 && s.prior >= 0);
    assert.ok(s.iFrom >= 0 && s.iTo < s.n, `${s.code} iFrom/iTo`);
  }
});

test('每只股票：bin 内 bar 数与 index 一致、日期落在声明窗口内', () => {
  const sample = [];
  for (let i = 0; i < STOCKS.length; i += 97) sample.push(STOCKS[i]);
  for (const s of sample) {
    const b = bars(s.code);
    assert.equal(b.n, s.n, `${s.code} bar 数`);
    assert.ok(b.dates[0] >= IDX.window[0], `${s.code} 首根 ${b.dates[0]}`);
    assert.ok(b.dates[b.n - 1] <= IDX.window[1], `${s.code} 末根 ${b.dates[b.n - 1]}`);
    assert.ok(b.dates[s.iFrom] >= IDX.random[0], `${s.code} iFrom 日期`);
    assert.ok(b.dates[s.iTo] <= IDX.random[1], `${s.code} iTo 日期`);
  }
});

test('每个 horizon 都能抽到足够多的样本，且抽中的窗口合法', () => {
  let seed = 20240921;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (const horizon of [30, 60, 90]) {
    const cands = [];
    for (const s of STOCKS) {
      const r = eligibleRange(s, horizon);
      if (r) cands.push({ s, lo: r.lo, hi: r.hi });
    }
    assert.ok(cands.length > 3000, `horizon=${horizon} 候选股票 ${cands.length}`);

    const seen = { boards: new Set(), dates: [] };
    for (let k = 0; k < 60; k++) {
      const c = cands[Math.floor(rng() * cands.length)];
      const b = bars(c.s.code);
      const start = c.lo + Math.floor(rng() * (c.hi - c.lo + 1));
      assert.ok(start >= PRE_BARS, '前 3 个月 K 线');
      assert.ok(start + horizon <= b.n - 1, '窗口后仍有足够交易日');
      assert.ok(b.dates[start] >= IDX.random[0] && b.dates[start] <= IDX.random[1], '随机日期在声明区间内');
      assert.ok(b.dates[start - PRE_BARS] > 0, '前置 K 线存在');
      seen.boards.add(c.s.boardIdx);
      seen.dates.push(b.dates[start]);
      // 真正抽样时会被过滤掉的停牌窗口，这里最多容忍 5%
      if (!windowGapOk(b, start, horizon)) seen.gaps = (seen.gaps || 0) + 1;
    }
    assert.ok((seen.gaps || 0) <= 3, `horizon=${horizon} 停牌窗口过多：${seen.gaps}`);
    const dmin = Math.min(...seen.dates), dmax = Math.max(...seen.dates);
    assert.ok(dmin >= IDX.random[0] && dmax <= IDX.random[1]);
  }
});

test('真实数据上跑完整局：满仓持有的组合收益 ≈ 个股区间涨幅', () => {
  const s0 = STOCKS.find(x => x.code === 'sh600000');
  const b = bars(s0.code);
  for (const horizon of [30, 60, 90]) {
    const r = eligibleRange(s0, horizon);
    assert.ok(r, `600000 horizon=${horizon}`);
    const start = r.lo + 5;
    const s = new Session({
      bars: b, stock: { code: s0.code, name: s0.name, boardIdx: s0.boardIdx },
      startIdx: start, horizon, position: 1, capital: 100000, fees: false, fillMode: 'open',
    });
    const first = s.order('add', 1);
    assert.equal(first.ok, true, '首次买入应成功');
    s.nextDay();
    while (!s.finished) s.nextDay();
    assert.equal(s.day, horizon);
    assert.equal(s.cur, start + horizon);
    const stockRet = b.close[s.cur] / b.open[start + 1] - 1;
    assert.ok(Math.abs(s.returnPct - stockRet) < 0.01,
      `horizon=${horizon} 组合 ${(s.returnPct * 100).toFixed(2)}% vs 个股 ${(stockRet * 100).toFixed(2)}%`);
    assert.ok(Math.abs(s.equity - s.cash) < 1e-6, '结算后全为现金');
    const sum = s.summary();
    assert.equal(sum.board, BOARDS[s0.boardIdx]);
    assert.equal(sum.buys, 1);
    assert.ok(sum.finalEquity > 0);
  }
});

test('真实数据上随机 300 局：不出现负现金 / 负持仓 / 未来数据', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let runs = 0;
  for (let k = 0; k < 300; k++) {
    const s0 = STOCKS[Math.floor(rng() * STOCKS.length)];
    const horizon = [30, 60, 90][Math.floor(rng() * 3)];
    const r = eligibleRange(s0, horizon);
    if (!r) continue;
    const b = bars(s0.code);
    let start = r.lo + Math.floor(rng() * (r.hi - r.lo + 1));
    if (!windowGapOk(b, start, horizon)) continue;
    const fillMode = k % 2 ? 'open' : 'close';
    const s = new Session({
      bars: b, stock: { code: s0.code, name: s0.name, boardIdx: s0.boardIdx },
      startIdx: start, horizon, position: 0.5, capital: 200000, fees: true, fillMode,
    });
    runs++;
    let steps = 0;
    while (!s.finished && steps < 200) {
      const roll = rng();
      if (roll < 0.22) s.order('add', [1, 0.5, 1 / 3][steps % 3]);
      else if (roll < 0.4) s.order(roll < 0.32 ? 'reduce' : 'clear', 0.5);
      else if (roll < 0.45 && s.pending.length) s.cancelOrder(s.pending[0].id);
      s.nextDay();
      assert.ok(s.cash >= -1e-6, `${s0.code} 现金为负`);
      assert.ok(s.shares >= 0);
      assert.ok(Math.abs(s.equity - (s.cash + s.shares * b.close[s.cur])) < 1e-6);
      assert.ok(s.cur <= start + horizon, '越过了窗口右边界（未来数据）');
      assert.ok(s.cur <= b.n - 1);
      steps++;
    }
    assert.equal(s.finished, true);
    assert.ok(Math.abs(s.equity - s.cash) < 1e-6);
  }
  assert.ok(runs > 150, `实际跑了 ${runs} 局`);
});
