/**
 * 解码器测试：用 Python 侧（tools/dump_fixture.py）导出的样本逐根比对，
 * 确保浏览器端解码结果与构建端完全一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKLC, fmtDate, fmtVol, fmtAmount, HEADER_SIZE, RECORD_SIZE } from '../docs/js/decode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const CASES = ['600000', '300750', '688256', '000001'];

for (const code of CASES) {
  test(`decode ${code} 与 Python 侧逐根一致`, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', `${code}.json`), 'utf8'));
    const buf = fs.readFileSync(path.join(DATA, `${code}.bin`));
    assert.equal(buf.byteLength, fx.binBytes, '文件长度');
    assert.equal(buf.byteLength, HEADER_SIZE + RECORD_SIZE * fx.n, '32 + 12n');

    const bars = decodeKLC(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.equal(bars.n, fx.n, 'bar 数');

    for (let i = 0; i < bars.n; i++) {
      assert.equal(bars.dates[i], fx.dates[i], `dates[${i}]`);
      for (const f of ['open', 'high', 'low', 'close']) {
        // 客户端把价格取整到「分」（A 股报价粒度），所以容差放到半分
        assert.ok(Math.abs(bars[f][i] - fx[f][i]) < 6e-3,
          `${f}[${i}] ${bars[f][i]} vs ${fx[f][i]}`);
      }
      assert.ok(Math.abs(bars.vol[i] - fx.vol[i]) <= Math.max(1, fx.vol[i] * 1e-5),
        `vol[${i}] ${bars.vol[i]} vs ${fx.vol[i]}`);
    }
  });
}

test('K 线自身一致性：high >= max(open,close)，low <= min(open,close)', () => {
  const buf = fs.readFileSync(path.join(DATA, '600000.bin'));
  const bars = decodeKLC(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (let i = 0; i < bars.n; i++) {
    assert.ok(bars.high[i] >= Math.max(bars.open[i], bars.close[i]) - 1e-6);
    assert.ok(bars.low[i] <= Math.min(bars.open[i], bars.close[i]) + 1e-6);
    assert.ok(bars.low[i] > 0 && bars.vol[i] > 0);
    if (i) assert.ok(bars.dates[i] > bars.dates[i - 1], '日期严格递增');
  }
});

test('损坏数据要抛错而不是静默返回', () => {
  assert.throws(() => decodeKLC(new ArrayBuffer(4)), /长度不足/);
  const bad = new ArrayBuffer(64);
  new DataView(bad).setUint8(0, 88);
  assert.throws(() => decodeKLC(bad), /magic/);
});

test('格式化函数', () => {
  assert.equal(fmtDate(20240902), '2024-09-02');
  assert.equal(fmtVol(1234 * 100), '1234手');
  assert.equal(fmtVol(12345 * 100), '1.23万手');
  assert.equal(fmtAmount(1.5e8), '1.50亿');
});

test('index.json 与实际文件一一对应', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
  assert.ok(idx.stocks.length > 4000, '股票数');
  for (const s of idx.stocks.slice(0, 50)) {
    const f = path.join(DATA, `${s[0].slice(2)}.bin`);
    assert.ok(fs.existsSync(f), f);
  }
  const bad = idx.stocks.filter(s => !(s[5] <= s[6]));
  assert.equal(bad.length, 0, 'iFrom 应 <= iTo：' + bad.slice(0, 3).map(s => s[0]));
});
