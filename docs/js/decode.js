/**
 * KLC1 二进制日线解码器（与 tools/build_data.py 的打包格式一一对应）。
 *
 * 头 32 字节（小端）：
 *   0  magic 4s "KLC1" | 4 n u32 | 8 date0 u32 | 12 pmin f32 | 16 pstep f32
 *   20 vmin f32 | 24 vstep f32 | 28 reserved u32
 * 随后 6 个定长数组，各 n 个 u16：
 *   gap, open, high, low, close, vol
 *   date[i] = date0 + Σ gap[0..i]（自然日）
 *   price   = pmin + q * pstep
 *   vol     = exp(vmin + q * vstep)   单位：股
 */

export const HEADER_SIZE = 32;
export const RECORD_SIZE = 12;

export function decodeKLC(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < HEADER_SIZE) throw new Error('数据文件损坏：长度不足');
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'KLC1') throw new Error('数据文件损坏：magic=' + magic);

  const n = dv.getUint32(4, true);
  const date0 = dv.getUint32(8, true);
  const pmin = dv.getFloat32(12, true);
  const pstep = dv.getFloat32(16, true);
  const vmin = dv.getFloat32(20, true);
  const vstep = dv.getFloat32(24, true);

  if (buffer.byteLength < HEADER_SIZE + RECORD_SIZE * n) {
    throw new Error('数据文件损坏：声明 ' + n + ' 根 bar，实际长度不足');
  }

  const dates = new Int32Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const vol = new Float64Array(n);

  let acc = date0;
  for (let i = 0; i < n; i++) {
    acc += dv.getUint16(HEADER_SIZE + i * 2, true);
    dates[i] = acc;
  }
  const oOff = HEADER_SIZE + 2 * n;
  const hOff = oOff + 2 * n;
  const lOff = hOff + 2 * n;
  const cOff = lOff + 2 * n;
  const vOff = cOff + 2 * n;
  // 价格统一取整到「分」：A 股真实报价就是 0.01 一跳，
  // 这样「成交价 × 股数 = 成交额」「成本价」「成交后总资产」全部能用计算器验算，
  // 也避免出现 35.0797 这种显示 35.08、却按 35.0797 计账的割裂。
  // 取整是单调的，不会破坏 high >= max(open, close) 这类关系。
  const r2 = x => Math.round(x * 100) / 100;
  for (let i = 0; i < n; i++) {
    open[i] = r2(pmin + dv.getUint16(oOff + i * 2, true) * pstep);
    high[i] = r2(pmin + dv.getUint16(hOff + i * 2, true) * pstep);
    low[i] = r2(pmin + dv.getUint16(lOff + i * 2, true) * pstep);
    close[i] = r2(pmin + dv.getUint16(cOff + i * 2, true) * pstep);
    vol[i] = Math.exp(vmin + dv.getUint16(vOff + i * 2, true) * vstep);
  }
  return { n, dates, open, high, low, close, vol };
}

/** 20240902 -> "2024-09-02" */
export function fmtDate(d) {
  const s = String(d);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/** 成交量（股）-> "1234万手" / "12.3万手" / "3456手" */
export function fmtVol(shares) {
  const hands = shares / 100;
  if (hands >= 1e8) return (hands / 1e8).toFixed(2) + '亿手';
  if (hands >= 1e4) return (hands / 1e4).toFixed(2) + '万手';
  return Math.round(hands) + '手';
}

/** 成交额（元）-> "1.23亿" */
export function fmtAmount(yuan) {
  if (yuan >= 1e8) return (yuan / 1e8).toFixed(2) + '亿';
  if (yuan >= 1e4) return (yuan / 1e4).toFixed(2) + '万';
  return Math.round(yuan) + '';
}
