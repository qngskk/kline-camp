/**
 * Canvas K 线图：K 线 + 成交量 + 买卖标记 + 成本线 + 十字光标。
 * 不依赖任何第三方库；A 股配色（红涨绿跌）。
 */
import { fmtDate, fmtVol, fmtAmount } from './decode.js';
import { macd } from './sim.js';

const UP = '#ef4444';
const DOWN = '#22c55e';
const FLAT = '#94a3b8';
const TEXT = '#cbd5e1';
const MUTED = '#8b9bb4';
const GRID = 'rgba(148,163,184,0.13)';
const CROSS = 'rgba(226,232,240,0.75)';
const MA_COLORS = ['#f59e0b', '#38bdf8', '#c084fc', '#f472b6'];
const MA_CUSTOM_COLOR = '#22d3ee';   // 自定义均线（输入天数）用青色

function niceTicks(min, max, count) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export class KChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = null;
    this.ma = [];
    this.marks = [];
    this.cost = null;
    this.limit = 0;          // 最多画到哪根 bar（含）
    this.viewFrom = 0;
    this.viewTo = 0;
    this.hover = null;
    this.pad = { l: 8, r: 64, t: 10, b: 22 };
    this.drag = null;
    this.maPeriods = [5, 10, 20, 60];
    this.maCustom = 0;        // 自定义均线周期（工具栏输入框，0 = 不显示）
    this.maCustomArr = null;
    this.maOn = { 5: true, 10: true, 20: true, 60: true };   // 每条内置均线独立开关
    this.showMACD = true;   // MACD 副图
    this.macdRes = null;
    this.lines = [];        // 手动画线，锚在「数据坐标」(bar 下标, 价格)，缩放平移后不会漂
    this.drawMode = false;
    this.draft = null;
    this._bindEvents();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  // ---- 数据 --------------------------------------------------------------
  setData(bars, limit = bars ? bars.n - 1 : 0) {
    this.bars = bars;
    this.limit = limit;
    this.hover = null;
    this.lines = [];
    this.draft = null;
    if (bars) {
      this.ma = this.maPeriods.map(p => movingAverage(bars.close, p));
      this.maCustomArr = this.maCustom >= 2 ? movingAverage(bars.close, this.maCustom) : null;
      this.macdRes = macd(bars.close);
      const end = limit;
      const from = Math.max(0, end - Math.min(120, end + 1) + 1);
      this.setView(from, end);
    }
    this.render();
  }

  setLimit(limit, follow = true) {
    if (!this.bars) return;
    const wasAtRight = this.viewTo >= this.limit;
    const oldLimit = this.limit;
    this.limit = Math.min(limit, this.bars.n - 1);
    if (follow && wasAtRight && this.limit > oldLimit) {
      const shift = this.limit - oldLimit;
      this.setView(this.viewFrom + shift, this.viewTo + shift);
    }
    this.render();
  }

  setMarks(marks) { this.marks = marks || []; this.render(); }

  /** 手动划线模式开关 */
  setDrawMode(on) {
    this.drawMode = !!on;
    this.draft = null;
    this.canvas.style.cursor = this.drawMode ? 'crosshair' : 'default';
    this.render();
  }

  clearLines() { this.lines = []; this.draft = null; this.render(); return this.lines.length; }
  undoLine() { const n = this.lines.pop(); this.draft = null; this.render(); return !!n; }
  setCost(price) { this.cost = price; this.render(); }
  /** 单条内置均线开关 */
  setMAOn(period, on) {
    if (!(period in this.maOn)) return;
    this.maOn[period] = !!on;
    this.render();
  }
  /** 一次性开关全部内置均线（保留给自动化测试用） */
  setShowMA(on) {
    for (const p of this.maPeriods) this.maOn[p] = !!on;
    this.render();
  }
  /** 当前内置均线里开着的条数 */
  get maOnCount() { return this.maPeriods.filter(p => this.maOn[p]).length; }
  /** 图例用：正在显示的内置均线 [{p, color}] */
  get maLegend() {
    return this.maPeriods.map((p, k) => ({ p, color: MA_COLORS[k % MA_COLORS.length], on: !!this.maOn[p] }))
      .filter(x => x.on);
  }
  /** 内置全关且无自定义线时视为「均线关闭」 */
  get showMA() { return this.maOnCount > 0; }
  /** 设置自定义均线周期（天数）。0 或非法值 = 关掉 */
  setCustomMA(n) {
    const v = Math.floor(Number(n) || 0);
    this.maCustom = v >= 2 && v <= 500 ? v : 0;
    this.maCustomArr = (this.maCustom && this.bars) ? movingAverage(this.bars.close, this.maCustom) : null;
    this.render();
    return this.maCustom;
  }
  setShowMACD(on) { this.showMACD = !!on; this.render(); }

  setView(from, to) {
    if (!this.bars) return;
    const maxIdx = this.limit;
    let count = Math.max(20, Math.min(to - from + 1, maxIdx + 1));
    let f = Math.max(0, Math.min(from, maxIdx + 1 - count));
    let t = Math.min(maxIdx, f + count - 1);
    f = Math.max(0, t - count + 1);
    this.viewFrom = f;
    this.viewTo = t;
    this.zoom = count;
  }

  /** 让视图显示 end 之前 minBars 根 K 线 */
  autoView(end, minBars = 90) {
    const to = Math.min(end, this.limit);
    const from = Math.max(0, to - minBars + 1);
    this.setView(from, to);
    this.render();
  }

  resize() {
    const el = this.canvas;
    const parent = el.parentElement || el;
    const w = parent.clientWidth, h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.render();
  }

  // ---- 几何 --------------------------------------------------------------
  _geom() {
    const { l, r, t, b } = this.pad;
    const plotW = Math.max(10, this.W - l - r);
    const plotH = Math.max(10, this.H - t - b);
    const gap = 10;
    if (this.showMACD && this.macdRes) {
      const volH = Math.max(26, Math.round(plotH * 0.15));
      const macdH = Math.max(40, Math.round(plotH * 0.24));
      const priceH = plotH - volH - macdH - gap * 2;
      return {
        x: l, plotW,
        price: { x: l, y: t, w: plotW, h: priceH },
        vol: { x: l, y: t + priceH + gap, w: plotW, h: volH },
        macd: { x: l, y: t + priceH + gap + volH + gap, w: plotW, h: macdH },
      };
    }
    const volH = Math.max(30, Math.round(plotH * 0.22));
    const priceH = plotH - volH - gap;
    return {
      x: l, plotW,
      price: { x: l, y: t, w: plotW, h: priceH },
      vol: { x: l, y: t + priceH + gap, w: plotW, h: volH },
      macd: null,
    };
  }

  _x(i, g) {
    const count = this.viewTo - this.viewFrom + 1;
    const cw = g.plotW / count;
    return g.x + (i - this.viewFrom + 0.5) * cw;
  }

  _idxAt(px, g) {
    const count = this.viewTo - this.viewFrom + 1;
    const cw = g.plotW / count;
    return Math.max(this.viewFrom, Math.min(this.viewTo, Math.floor((px - g.x) / cw) + this.viewFrom));
  }

  // ---- 渲染 --------------------------------------------------------------
  render() {
    const ctx = this.ctx;
    if (!this.W) return;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.bars || this.bars.n === 0) return;
    const g = this._geom();
    const vf = this.viewFrom, vt = this.viewTo;
    const bars = this.bars;

    let pmin = Infinity, pmax = -Infinity, vmax = 0;
    for (let i = vf; i <= vt; i++) {
      if (bars.low[i] < pmin) pmin = bars.low[i];
      if (bars.high[i] > pmax) pmax = bars.high[i];
      if (bars.vol[i] > vmax) vmax = bars.vol[i];
    }
    {
      // 纵轴范围要把**正在显示的**均线也算进去，否则线会被裁掉
      const shown = [];
      this.maPeriods.forEach((p, k) => { if (this.maOn[p]) shown.push(this.ma[k]); });
      if (this.maCustomArr) shown.push(this.maCustomArr);
      for (const arr of shown) {
        for (let i = vf; i <= vt; i++) {
          const v = arr[i];
          if (isFinite(v)) { if (v < pmin) pmin = v; if (v > pmax) pmax = v; }
        }
      }
    }
    if (pmin === Infinity) { pmin = 0; pmax = 1; }
    const padP = (pmax - pmin) * 0.06 || pmax * 0.01 || 1;
    pmin -= padP; pmax += padP;
    if (pmin < 0) pmin = 0;
    if (vmax <= 0) vmax = 1;

    const yP = p => g.price.y + (pmax - p) / (pmax - pmin) * g.price.h;
    const yV = v => g.vol.y + g.vol.h - (v / vmax) * g.vol.h;
    this._scale = { pmin, pmax };          // 供屏幕坐标 ↔ 数据坐标换算

    // --- 网格与价格轴
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const ticks = niceTicks(pmin, pmax, 5);
    for (const p of ticks) {
      if (p < pmin || p > pmax) continue;
      const y = Math.round(yP(p)) + 0.5;
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.plotW, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(2), g.x + g.plotW + 6, y);
    }
    // 成交量轴
    const vy = Math.round(g.vol.y) + 0.5;
    ctx.strokeStyle = GRID; ctx.beginPath();
    ctx.moveTo(g.x, vy); ctx.lineTo(g.x + g.plotW, vy); ctx.stroke();
    ctx.fillStyle = MUTED; ctx.textAlign = 'left';
    ctx.fillText(fmtVol(vmax), g.x + g.plotW + 6, g.vol.y + 8);

    // --- 日期轴
    const count = vt - vf + 1;
    const stepX = Math.max(1, Math.ceil(count / Math.max(3, Math.floor(g.plotW / 78))));
    ctx.textAlign = 'center';
    for (let i = vt; i >= vf; i -= stepX) {
      const x = this._x(i, g);
      ctx.strokeStyle = GRID; ctx.beginPath();
      const bot = g.macd ? g.macd.y + g.macd.h : g.vol.y + g.vol.h;
      ctx.moveTo(Math.round(x) + 0.5, g.price.y); ctx.lineTo(Math.round(x) + 0.5, bot); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(fmtDate(bars.dates[i]).slice(5), x, this.H - 10);
    }

    // --- K 线
    const cw = g.plotW / count;
    const bodyW = Math.max(1, Math.min(24, cw * 0.66));
    for (let i = vf; i <= vt; i++) {
      const o = bars.open[i], c = bars.close[i], h = bars.high[i], lw = bars.low[i];
      const up = c >= o;
      const col = c > o ? UP : c < o ? DOWN : FLAT;
      const x = this._x(i, g);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yP(h));
      ctx.lineTo(Math.round(x) + 0.5, yP(lw));
      ctx.stroke();
      const yo = yP(o), yc = yP(c);
      const top = Math.min(yo, yc);
      const hgt = Math.max(1, Math.abs(yc - yo));
      // A 股习惯：阳线红（空心感用淡填充），阴线绿实心
      if (up) {
        ctx.fillStyle = 'rgba(239,68,68,0.85)';
        ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
      } else {
        ctx.fillStyle = 'rgba(34,197,94,0.95)';
        ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
      }
    }

    // --- 均线：内置的 MA5/10/20/60 归「均线」开关管；
    //     输入框那条是独立的（这样才能只看 MA120、关掉其余均线）
    {
      ctx.lineWidth = 1.2;
      const series = [];
      this.maPeriods.forEach((p, k) => {
        if (this.maOn[p]) series.push([this.ma[k], MA_COLORS[k % MA_COLORS.length]]);
      });
      if (this.maCustomArr) series.push([this.maCustomArr, MA_CUSTOM_COLOR]);
      series.forEach(([arr, color]) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        let started = false;
        for (let i = vf; i <= vt; i++) {
          const v = arr[i];
          if (!isFinite(v)) { started = false; continue; }
          const x = this._x(i, g), y = yP(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    }

    // --- 成交量柱
    for (let i = vf; i <= vt; i++) {
      const up = bars.close[i] >= bars.open[i];
      const x = this._x(i, g);
      ctx.fillStyle = up ? 'rgba(239,68,68,0.55)' : 'rgba(34,197,94,0.55)';
      const y = yV(bars.vol[i]);
      ctx.fillRect(x - bodyW / 2, y, bodyW, g.vol.y + g.vol.h - y);
    }

    // --- 成本线
    if (this.cost && this.cost >= pmin && this.cost <= pmax) {
      const y = Math.round(yP(this.cost)) + 0.5;
      ctx.save();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.plotW, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'left';
      ctx.fillText('成本 ' + this.cost.toFixed(2), g.x + 4, y - 8);
    }

    // --- 买卖标记（同一根 K 线上的多笔按先后错开，避免叠在一起）
    const stack = new Map();
    for (const m of this.marks) {
      const k = stack.get(m.idx) || 0;
      stack.set(m.idx, k + 1);
      if (m.idx < vf || m.idx > vt) continue;
      const x = this._x(m.idx, g);
      const buy = m.side === 'buy';
      const col = m.settle ? '#fbbf24' : buy ? '#ef4444' : '#22c55e';
      const gapY = 15;
      const y = buy ? yP(bars.low[m.idx]) + 15 + k * gapY : yP(bars.high[m.idx]) - 15 - k * gapY;
      ctx.fillStyle = col;
      ctx.beginPath();
      if (buy) { ctx.moveTo(x, y - 11); ctx.lineTo(x - 6, y); ctx.lineTo(x + 6, y); }
      else { ctx.moveTo(x, y + 11); ctx.lineTo(x - 6, y); ctx.lineTo(x + 6, y); }
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold 10px ui-sans-serif, system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = col;
      ctx.fillText(m.settle ? '结' : buy ? 'B' : 'S', x, buy ? y + 8 : y - 8);
      ctx.fillStyle = 'rgba(226,232,240,0.9)';
      ctx.fillText(m.price.toFixed(2), x, buy ? y + 18 : y - 18);
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    }

    // --- MACD 副图
    if (g.macd && this.macdRes) {
      const { dif, dea, hist } = this.macdRes;
      const m = g.macd;
      let mmin = 0, mmax = 0;
      for (let i = vf; i <= vt; i++) {
        mmin = Math.min(mmin, dif[i], dea[i], hist[i]);
        mmax = Math.max(mmax, dif[i], dea[i], hist[i]);
      }
      const pad = (mmax - mmin) * 0.08 || Math.abs(mmax) * 0.1 || 1;
      mmin -= pad; mmax += pad;
      const yM = v => m.y + (mmax - v) / (mmax - mmin) * m.h;
      // 0 轴
      const y0 = Math.round(yM(0)) + 0.5;
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.x, y0); ctx.lineTo(m.x + m.w, y0); ctx.stroke();
      // 柱
      for (let i = vf; i <= vt; i++) {
        const x = this._x(i, g);
        const v = hist[i];
        ctx.fillStyle = v >= 0 ? 'rgba(239,68,68,.6)' : 'rgba(34,197,94,.6)';
        const y = yM(v);
        ctx.fillRect(x - bodyW / 2, Math.min(y, y0), bodyW, Math.max(1, Math.abs(y - y0)));
      }
      // DIF / DEA
      const line = (arr, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath();
        let started = false;
        for (let i = vf; i <= vt; i++) {
          const x = this._x(i, g), y = yM(arr[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      line(dif, '#f8fafc');
      line(dea, '#fbbf24');
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = MUTED;
      ctx.fillText('MACD(12,26,9)', m.x + 4, m.y + 8);
      ctx.fillStyle = '#f8fafc'; ctx.fillText('DIF', m.x + 78, m.y + 8);
      ctx.fillStyle = '#fbbf24'; ctx.fillText('DEA', m.x + 104, m.y + 8);
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText(mmax.toFixed(2), m.x + m.w + 6, m.y + 6);
      ctx.fillText(mmin.toFixed(2), m.x + m.w + 6, m.y + m.h - 6);
    }

    // --- 手动画线（剪裁在价格区内）
    if (this.lines.length || this.draft) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.price.x, g.price.y, g.price.w, g.price.h);
      ctx.clip();
      const stroke = (L, dashed) => {
        const x0 = this._x(L.i0, g), y0 = yP(L.p0);
        const x1 = this._x(L.i1, g), y1 = yP(L.p1);
        ctx.save();
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = dashed ? 1.2 : 1.6;
        ctx.shadowColor = 'rgba(2,6,23,.95)';
        ctx.shadowBlur = 4;
        if (dashed) ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.restore();
        if (!dashed) {
          ctx.fillStyle = '#e2e8f0';
          for (const [x, y] of [[x0, y0], [x1, y1]]) {
            ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
          }
          if (L.p0 > 0 && Math.abs(L.i1 - L.i0) >= 2) {
            const chg = L.p1 / L.p0 - 1;
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const txt = (chg >= 0 ? '+' : '') + (chg * 100).toFixed(2) + '%';
            const w = ctx.measureText(txt).width + 8;
            const ly = my - 13 < g.price.y + 8 ? my + 13 : my - 13;
            ctx.fillStyle = 'rgba(15,23,42,.9)';
            ctx.fillRect(mx - w / 2, ly - 7, w, 14);
            ctx.fillStyle = chg >= 0 ? '#fca5a5' : '#86efac';
            ctx.fillText(txt, mx, ly);
          }
        }
      };
      for (const L of this.lines) stroke(L, false);
      if (this.draft && (this.draft.i0 !== this.draft.i1 || this.draft.p0 !== this.draft.p1)) stroke(this.draft, true);
      ctx.restore();
    }

    // --- 十字光标
    if (this.hover != null && this.hover >= vf && this.hover <= vt) {
      const i = this.hover;
      const x = Math.round(this._x(i, g)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]); ctx.strokeStyle = CROSS; ctx.lineWidth = 1;
      const bottom = g.macd ? g.macd.y + g.macd.h : g.vol.y + g.vol.h;
      ctx.beginPath(); ctx.moveTo(x, g.price.y); ctx.lineTo(x, bottom); ctx.stroke();
      if (this.hoverY != null && this.hoverY > g.price.y && this.hoverY < g.price.y + g.price.h) {
        const y = Math.round(this.hoverY) + 0.5;
        ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.plotW, y); ctx.stroke();
        const p = pmax - (y - g.price.y) / g.price.h * (pmax - pmin);
        ctx.setLineDash([]);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(g.x + g.plotW + 2, y - 8, 60, 16);
        ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left';
        ctx.fillText(p.toFixed(2), g.x + g.plotW + 6, y);
      }
      ctx.restore();
      this._tooltip(i, g, x);
    }
    ctx.textBaseline = 'alphabetic';
  }

  _tooltip(i, g, x) {
    const ctx = this.ctx, b = this.bars;
    const prev = i > 0 ? b.close[i - 1] : b.open[i];
    const chg = prev > 0 ? b.close[i] / prev - 1 : 0;
    const up = b.close[i] >= b.open[i];
    const lines = [
      ['日期', fmtDate(b.dates[i])],
      ['开盘', b.open[i].toFixed(2)],
      ['最高', b.high[i].toFixed(2)],
      ['最低', b.low[i].toFixed(2)],
      ['收盘', b.close[i].toFixed(2)],
      ['涨跌', (chg >= 0 ? '+' : '') + (chg * 100).toFixed(2) + '%'],
      ['成交量', fmtVol(b.vol[i])],
      // 本地只打包了 OHLCV，没有真实成交额；用典型价 (H+L+C)/3 估算，
      // 与真实成交额的中位偏差 0.2%、99 分位 1.7%（见 tools/verify_data.py）
      ['成交额≈', fmtAmount((b.high[i] + b.low[i] + b.close[i]) / 3 * b.vol[i]) + '元'],
    ];
    if (this.showMACD && this.macdRes) {
      const { dif, dea, hist } = this.macdRes;
      lines.push(['MACD', hist[i].toFixed(3), MUTED]);
      lines.push(['DIF', dif[i].toFixed(3), '#f8fafc']);
      lines.push(['DEA', dea[i].toFixed(3), '#fbbf24']);
    }
    {                                        // 均线的值也列出来，方便直接读乖离
      this.maPeriods.forEach((p, k) => {
        if (!this.maOn[p]) return;
        const v = this.ma[k] ? this.ma[k][i] : NaN;
        if (isFinite(v)) lines.push(['MA' + p, v.toFixed(2), MA_COLORS[k % MA_COLORS.length]]);
      });
      if (this.maCustomArr) {
        const v = this.maCustomArr[i];
        if (isFinite(v)) lines.push(['MA' + this.maCustom, v.toFixed(2), MA_CUSTOM_COLOR]);
      }
    }
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const w = 118, lh = 15, h = lines.length * lh + 10;
    let tx = x + 14;
    if (tx + w > g.x + g.plotW) tx = x - w - 14;
    const ty = g.price.y + 6;
    ctx.fillStyle = 'rgba(15,23,42,0.94)';
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, w, h, 5); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    lines.forEach(([k, v, col], n) => {
      const y = ty + 5 + lh * n + lh / 2;
      ctx.fillStyle = col || MUTED; ctx.fillText(k, tx + 8, y);
      ctx.fillStyle = col || ((k === '涨跌') ? (chg >= 0 ? UP : DOWN) : (k === '收盘' ? (up ? UP : DOWN) : TEXT));
      ctx.fillText(v, tx + 52, y);
    });
    ctx.textBaseline = 'alphabetic';
  }

  /** 屏幕坐标 → 数据坐标（bar 下标 + 价格），用于手动画线的锚点 */
  toData(px, py) {
    const g = this._geom();
    const s = this._scale || { pmin: 0, pmax: 1 };
    const i = this._idxAt(px, g);
    const p = s.pmax - (py - g.price.y) / g.price.h * (s.pmax - s.pmin);
    return { i, p: Math.round(p * 100) / 100 };
  }

  // ---- 交互 --------------------------------------------------------------
  _bindEvents() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('wheel', e => {
      if (!this.bars) return;
      e.preventDefault();
      const g = this._geom();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const anchor = this._idxAt(px, g);
      const count = this.viewTo - this.viewFrom + 1;
      const ratio = (anchor - this.viewFrom) / Math.max(1, count - 1);
      const next = Math.max(20, Math.min(this.limit + 1, Math.round(count * (e.deltaY > 0 ? 1.15 : 0.87))));
      let from = Math.round(anchor - ratio * (next - 1));
      this.setView(from, from + next - 1);
      this.render();
    }, { passive: false });

    el.addEventListener('pointerdown', e => {
      if (!this.bars) return;
      const rect = el.getBoundingClientRect();
      if (this.drawMode) {                       // 划线模式：按下=起点
        el.setPointerCapture(e.pointerId);
        const d = this.toData(e.clientX - rect.left, e.clientY - rect.top);
        this.draft = { i0: d.i, p0: d.p, i1: d.i, p1: d.p };
        this.render();
        return;
      }
      el.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, from: this.viewFrom, to: this.viewTo, moved: false };
    });
    el.addEventListener('pointermove', e => {
      if (!this.bars) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (this.drawMode && this.draft) {         // 拖动中：实时预览终点
        const d = this.toData(px, py);
        this.draft.i1 = d.i;
        this.draft.p1 = d.p;
        this.render();
        return;
      }
      if (this.drag) {
        const g = this._geom();
        const cw = g.plotW / (this.drag.to - this.drag.from + 1);
        const d = Math.round((px - (this.drag.x - rect.left)) / cw);
        if (Math.abs(e.clientX - this.drag.x) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          const count = this.drag.to - this.drag.from + 1;
          let from = this.drag.from - d;
          from = Math.max(0, Math.min(from, this.limit + 1 - count));
          this.setView(from, from + count - 1);
        }
      }
      const g = this._geom();
      this.hover = this._idxAt(px, g);
      this.hoverY = py;
      this.render();
    });
    const endDrag = () => {
      if (this.draft) {                          // 松开=终点，太短就丢弃
        const L = this.draft;
        if (L.i1 !== L.i0 || L.p1 !== L.p0) this.lines.push({ ...L });
        this.draft = null;
        this.render();
        if (this.onLineChange) this.onLineChange(this.lines.length);
      }
      this.drag = null;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('pointerleave', () => {
      this.hover = null; this.hoverY = null; this.render();
    });
    el.addEventListener('dblclick', () => {
      this.autoView(this.limit, 120);
    });
  }
}

function movingAverage(arr, period) {
  const n = arr.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
