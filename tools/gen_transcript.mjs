/**
 * 生成交易流水（供 tools/verify_sim.py 独立复核）。
 *
 * 用法： node tools/gen_transcript.mjs <code> <startIdx> <horizon> <fillMode> <out.json>
 * 例：   node tools/gen_transcript.mjs sh600000 120 30 close /tmp/t.json
 *
 * 动作序列由固定种子生成并写进流水，Python 侧按同一个序列逐笔重放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKLC } from '../docs/js/decode.js';
import { Session } from '../docs/js/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [code = 'sh600000', startIdx = '120', horizon = '30', fillMode = 'close', out = '/tmp/transcript.json'] =
  process.argv.slice(2);

const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'index.json'), 'utf8'));
const meta = idx.stocks.find(x => x[0] === code) || [code, code, 0];
const bin = fs.readFileSync(path.join(ROOT, 'docs', 'data', code.slice(2) + '.bin'));
const bars = decodeKLC(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

const CAPITAL = 100000;
const s = new Session({
  bars, stock: { code, name: meta[1], boardIdx: meta[2] },
  startIdx: Number(startIdx), horizon: Number(horizon),
  capital: CAPITAL, fees: true, fillMode,
});

// ---- 确定性动作序列 -------------------------------------------------------
let seed = 987654321;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const BUY_F = ['1/4', '1/3', '1/2', '1'];
const SELL_F = ['1/4', '1/3', '1/2'];
const actions = [];
for (let i = 0; i < Number(horizon); i++) {
  const rolls = 1 + Math.floor(rnd() * 3);
  for (let r = 0; r < rolls; r++) {
    const x = rnd();
    if (x < 0.34) actions.push({ type: 'order', kind: 'add', frac: BUY_F[Math.floor(rnd() * 4)] });
    else if (x < 0.5) actions.push({ type: 'order', kind: 'full' });
    else if (x < 0.68) actions.push({ type: 'order', kind: 'reduce', frac: SELL_F[Math.floor(rnd() * 3)] });
    else if (x < 0.78) actions.push({ type: 'order', kind: 'clear' });
    else if (x < 0.86 && fillMode === 'open') actions.push({ type: 'cancel' });
    // 其余不操作
  }
  actions.push({ type: 'next' });
}

// ---- 执行并逐步记录 -------------------------------------------------------
const steps = [];
let k = 0;
while (!s.finished && k < actions.length) {
  const a = actions[k];
  const snap = () => ({
    cur: s.cur, date: s.date, cash: s.cash, shares: s.shares, costTotal: s.costTotal,
    avgCost: s.avgCost, equity: s.equity, returnPct: s.returnPct, realized: s.realized,
    totalFee: s.totalFee, positionPct: s.positionPct, sellable: s.sellableShares,
    boughtToday: s.boughtToday, finished: s.finished, pending: s.pending.length,
  });
  let res = null;
  if (a.type === 'order') {
    res = s.order(a.kind, a.frac ? evalFrac(a.frac) : 1);
  } else if (a.type === 'cancel') {
    res = s.pending.length ? s.cancelOrder(s.pending[0].id) : { ok: true, noop: true };
  } else {
    res = s.nextDay();
  }
  steps.push({
    i: k, action: a, state: snap(),
    ok: res.ok !== false,
    code: res.code || null,
    order: res.order ? { side: res.order.side, kind: res.order.kind, shares: res.order.shares ?? null,
                         budget: res.order.budget ?? null, label: res.order.label } : null,
    fill: res.fill ? pick(res.fill) : null,
    fills: res.fills ? res.fills.map(pick) : null,
    rejects: res.rejects ? res.rejects.map(r => r.code) : null,
  });
  k++;
}
function pick(f) {
  return { side: f.side, price: f.price, shares: f.shares, amount: f.amount, fee: f.fee,
           total: f.total, pnl: f.pnl ?? null, idx: f.idx, date: f.date, label: f.label };
}
function evalFrac(t) {
  if (String(t).includes('/')) { const [a, b] = String(t).split('/').map(Number); return a / b; }
  return parseFloat(t);
}

fs.writeFileSync(out, JSON.stringify({
  code, boardIdx: meta[2], startIdx: Number(startIdx), horizon: Number(horizon), fillMode,
  capital: CAPITAL, fees: true, actions, steps, summary: s.summary(),
  bars: { n: bars.n },
}, null, 1));
console.log(`${code} ${fillMode}: ${steps.length} 步，${s.log.length} 笔成交 → ${out}`);
