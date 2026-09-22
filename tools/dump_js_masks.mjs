/** 用前端实现复算筛选掩码，与 Python 侧（filter.bin 的生成口径）逐条比对。
 *  用法： node tools/dump_js_masks.mjs /tmp/masks.json */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKLC } from '../docs/js/decode.js';
import { macd, filterDetail } from '../docs/js/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cache = new Map();
let bad = 0, checked = 0;
const byCode = new Map();
for (const c of cases) {
  if (!byCode.has(c.code)) byCode.set(c.code, []);
  byCode.get(c.code).push(c);
}
for (const [code, list] of byCode) {
  const buf = fs.readFileSync(path.join(ROOT, 'docs', 'data', code.slice(2) + '.bin'));
  const bars = decodeKLC(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const m = macd(bars.close);
  for (const c of list) {
    const i = bars.dates.indexOf(c.date);
    // 当天停牌/未上市 → 两边都不适用，Python 侧同样记为 0
    if (i < 0) { checked++; if (c.mask !== 0) { bad++; console.log(`  ❌ ${code} ${c.date} 无该交易日但 Python=${c.mask}`); } continue; }
    const d = filterDetail(bars, i, m);
    checked++;
    if (d.mask !== c.mask) {
      bad++;
      console.log(`  ❌ ${code} ${c.date}  Python=${c.mask.toString(2).padStart(5,'0')} ` +
                  `JS=${d.mask.toString(2).padStart(5,'0')}`);
    }
  }
}
console.log(`比对 ${checked} 个「股票×日期」的筛选掩码（7 个条件）: ${bad ? '❌ ' + bad + ' 处不一致' : '✅ 全部一致'}`);
process.exit(bad ? 1 : 0);
