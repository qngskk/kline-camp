/**
 * 训练仿真引擎 —— 纯逻辑，不依赖 DOM，可直接在 Node 里跑单元测试。
 *
 * 交易规则（页面「规则」面板同源展示）
 * ------------------------------------
 * 1. 初始资金默认 10 万元；现金 + 持仓市值 = 总资产。
 * 2. 决策只能基于「已揭示的最后一根 K 线」及其之前的信息；
 *    所有委托（买入 / 卖出 / 结束交易清仓）一律以**次日开盘价**成交。
 * 3. 仓位 = 本次买入动用「当前总资产」的比例（满仓 / 1/2 / 1/3 / 1/4），
 *    同时受可用现金约束；按 A 股一手 = 100 股向下取整。
 * 4. 涨停开盘无法买入、跌停开盘无法卖出（涨跌幅按板块：主板 10%，创业板/科创板 20%）。
 * 5. 卖出为全部清仓；买入后当日不可卖（T+1，由「次日开盘成交」天然满足）。
 * 6. 走到窗口最后一日自动结算；结算时按最后一日收盘价把剩余持仓折算为现金。
 * 7. 交易费用（可关闭）：佣金万 2.5（单笔最低 5 元）+ 过户费万 0.1，
 *    卖出另收印花税千 0.5。
 */

export const BOARDS = ['主板', '创业板', '科创板'];
export const LIMIT_PCT = [0.10, 0.20, 0.20];
export const LOT_SIZE = 100;
export const PRE_BARS = 60;         // 随机日期之前展示的「3 个月」≈ 60 个交易日
export const MIN_LISTED = 250;      // 次新股：上市不足 250 个交易日的样本不抽
export const MAX_GAP_DAYS = 15;     // 相邻 K 线自然日间隔上限（用于跳过长期停牌）
export const FEE = { commission: 0.00025, minCommission: 5, transfer: 0.00001, stamp: 0.0005 };

export function round2(x) { return Math.round(x * 100) / 100; }

/** YYYYMMDD -> 自 epoch 起的天数 */
export function dayNum(d) {
  const y = Math.floor(d / 10000), m = Math.floor((d % 10000) / 100), dd = d % 100;
  return Math.floor(Date.UTC(y, m - 1, dd) / 86400000);
}

/** 两个 YYYYMMDD 之间的自然日间隔 */
export function calendarGap(a, b) { return dayNum(b) - dayNum(a); }

export function limitUpOf(prevClose, boardIdx) {
  return round2(prevClose * (1 + (LIMIT_PCT[boardIdx] ?? 0.10)));
}
export function limitDownOf(prevClose, boardIdx) {
  return round2(prevClose * (1 - (LIMIT_PCT[boardIdx] ?? 0.10)));
}

/** 买入总支出（含费用） */
export function buyCost(price, shares, feesOn) {
  const gross = price * shares;
  if (!feesOn) return { gross, fee: 0, total: gross };
  const fee = Math.max(FEE.minCommission, gross * FEE.commission) + gross * FEE.transfer;
  return { gross, fee, total: gross + fee };
}

/** 卖出净收入（含费用与印花税） */
export function sellProceeds(price, shares, feesOn) {
  const gross = price * shares;
  if (!feesOn) return { gross, fee: 0, tax: 0, net: gross };
  const fee = Math.max(FEE.minCommission, gross * FEE.commission) + gross * FEE.transfer;
  const tax = gross * FEE.stamp;
  return { gross, fee, tax, net: gross - fee - tax };
}

/**
 * 该股票在当前 horizon 下允许被抽中的「随机日期」下标区间。
 * stock: index.json 里的一条记录 { n, prior, iFrom, iTo }
 */
export function eligibleRange(stock, horizon) {
  const lo = Math.max(PRE_BARS, MIN_LISTED - stock.prior, stock.iFrom);
  const hi = Math.min(stock.iTo, stock.n - 1 - horizon);
  return hi >= lo ? { lo, hi } : null;
}

/** 窗口 [from-PRE_BARS, from+horizon] 内是否存在长期停牌（相邻自然日间隔 > MAX_GAP_DAYS） */
export function windowGapOk(bars, from, horizon) {
  const a = Math.max(1, from - PRE_BARS);
  const b = Math.min(bars.n - 1, from + horizon);
  for (let i = a; i <= b; i++) {
    if (calendarGap(bars.dates[i - 1], bars.dates[i]) > MAX_GAP_DAYS) return false;
  }
  return true;
}

/** 在 [lo, hi] 中随机挑一个通过停牌检查的起始下标；失败返回 -1 */
export function pickStartIndex(bars, lo, hi, horizon, rng = Math.random, tries = 60) {
  for (let t = 0; t < tries; t++) {
    const i = lo + Math.floor(rng() * (hi - lo + 1));
    if (windowGapOk(bars, i, horizon)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------

export class Session {
  /**
   * @param {object} o
   * @param {object} o.bars      decodeKLC 的结果
   * @param {object} o.stock     {code, name, boardIdx}
   * @param {number} o.startIdx  随机日期在 bars 中的下标
   * @param {number} o.horizon   操作交易日数 30 / 60 / 90
   * @param {number} o.position  默认仓位 1 / 0.5 / 1/3 / 0.25
   */
  constructor({ bars, stock, startIdx, horizon, position = 1, capital = 100000, fees = true }) {
    this.bars = bars;
    this.stock = stock;
    this.startIdx = startIdx;
    this.horizon = horizon;
    this.position = position;
    this.capital = capital;
    this.fees = fees;
    this.boardIdx = stock.boardIdx ?? 0;

    this.cur = startIdx;
    this.lastIdx = Math.min(startIdx + horizon, bars.n - 1);
    this.day = 0;

    this.cash = capital;
    this.shares = 0;
    this.costTotal = 0;      // 当前持仓的买入成本（含费用）
    this.realized = 0;       // 已实现盈亏（已扣费用）
    this.totalFee = 0;

    this.log = [];           // 成交流水
    this.events = [];        // 提示信息
    this.marks = [];         // 图上标记 {idx, side, price, shares}
    this.curve = [{ idx: startIdx, equity: capital }];

    this.finished = false;
    this.settleReason = null;
    this.wins = 0;
    this.losses = 0;
  }

  // ---- 派生状态 ----------------------------------------------------------
  get price() { return this.bars.close[this.cur]; }
  get date() { return this.bars.dates[this.cur]; }
  get marketValue() { return this.shares * this.price; }
  get equity() { return this.cash + this.marketValue; }
  get returnPct() { return this.equity / this.capital - 1; }
  get avgCost() { return this.shares > 0 ? this.costTotal / this.shares : 0; }
  get floatPnl() { return this.shares > 0 ? this.marketValue - this.costTotal : 0; }
  get floatPct() { return this.shares > 0 && this.costTotal > 0 ? this.marketValue / this.costTotal - 1 : 0; }
  get canAct() { return !this.finished && this.day < this.horizon && this.cur < this.lastIdx; }
  get nextDate() { return this.cur < this.lastIdx ? this.bars.dates[this.cur + 1] : null; }
  get benchmarkPct() { return this.price / this.bars.close[this.startIdx] - 1; }
  get progress() { return this.day / this.horizon; }

  /** 相对随机日期收盘价的同期涨跌幅（买入并持有基准） */
  get daysLeft() { return Math.max(0, this.horizon - this.day); }

  get maxDrawdown() {
    let peak = -Infinity, mdd = 0;
    for (const p of this.curve) {
      if (p.equity > peak) peak = p.equity;
      mdd = Math.min(mdd, p.equity / peak - 1);
    }
    return mdd;
  }

  /** 当日涨跌幅（相对前一交易日收盘） */
  dayChangePct(idx = this.cur) {
    if (idx <= 0) return 0;
    return this.bars.close[idx] / this.bars.close[idx - 1] - 1;
  }

  limitsAt(idx) {
    const prev = this.bars.close[idx - 1];
    return { up: limitUpOf(prev, this.boardIdx), down: limitDownOf(prev, this.boardIdx) };
  }

  /** 预估买入股数（用当前收盘价估算，仅用于确认框提示） */
  estimateBuy(fraction) {
    const budget = Math.min(this.cash, this.equity * fraction);
    const px = this.price;
    if (!(px > 0)) return { shares: 0, budget };
    const perLot = px * LOT_SIZE * (this.fees ? 1 + FEE.commission + FEE.transfer : 1);
    return { shares: Math.floor(budget / perLot) * LOT_SIZE, budget };
  }

  // ---- 推进 --------------------------------------------------------------
  /**
   * 提交当日决策并揭示下一日：成交价 = 下一日开盘价。
   * @returns {{ok:boolean, code?:string, msg?:string, fill?:object}}
   */
  submit(action, fraction = this.position) {
    if (!this.canAct) return { ok: false, code: 'finished', msg: '本轮训练已结束' };

    const nextIdx = this.cur + 1;
    const px = this.bars.open[nextIdx];
    const lim = this.limitsAt(nextIdx);
    const date = this.bars.dates[nextIdx];
    const EPS = 0.005;

    let order = null;
    if (action === 'buy') {
      if (px >= lim.up - EPS) {
        this.events.push({ date, type: 'warn', text: `涨停开盘（${px.toFixed(2)}），无法买入` });
        return { ok: false, code: 'limitUp', msg: `次日涨停开盘，买不进，请重新决策` };
      }
      const budget = Math.min(this.cash, this.equity * fraction);
      const perLot = px * LOT_SIZE;
      const perLotCost = this.fees ? perLot * (1 + FEE.commission + FEE.transfer) : perLot;
      let shares = perLotCost > 0 ? Math.floor(budget / perLotCost) * LOT_SIZE : 0;
      while (shares > 0 && buyCost(px, shares, this.fees).total > this.cash + 1e-6) shares -= LOT_SIZE;
      if (shares <= 0) {
        return { ok: false, code: 'noFunds', msg: '可用资金不足一手（100 股），无法买入' };
      }
      order = { side: 'buy', shares };
    } else if (action === 'sell') {
      if (this.shares <= 0) return { ok: false, code: 'noPosition', msg: '当前没有持仓' };
      if (px <= lim.down + EPS) {
        this.events.push({ date, type: 'warn', text: `跌停开盘（${px.toFixed(2)}），无法卖出` });
        return { ok: false, code: 'limitDown', msg: '次日跌停开盘，卖不出，请重新决策' };
      }
      order = { side: 'sell', shares: this.shares };
    } else {
      order = null;
    }

    this.cur = nextIdx;
    this.day += 1;

    let fill = null;
    if (order) fill = this._execute(order, px, date);
    this.curve.push({ idx: this.cur, equity: this.equity });

    let auto = false;
    if (this.day >= this.horizon) { this.settle('horizon'); auto = true; }
    return { ok: true, fill, auto, barIdx: this.cur };
  }

  _execute(order, price, date) {
    if (order.side === 'buy') {
      const c = buyCost(price, order.shares, this.fees);
      this.cash -= c.total;
      this.costTotal += c.total;
      this.shares += order.shares;
      this.totalFee += c.fee;
      const fill = { side: 'buy', date, price, shares: order.shares, amount: c.gross,
                     fee: c.fee, total: c.total, idx: this.cur };
      this.log.push(fill); this.marks.push({ idx: this.cur, side: 'buy', price });
      this.events.push({ date, type: 'buy', text: `买入 ${order.shares} 股 @ ${price.toFixed(2)}` });
      return fill;
    }
    const s = sellProceeds(price, order.shares, this.fees);
    const cost = this.costTotal;
    const pnl = s.net - cost;
    this.realized += pnl;
    if (pnl >= 0) this.wins += 1; else this.losses += 1;
    this.cash += s.net;
    this.totalFee += s.fee + s.tax;
    const fill = { side: 'sell', date, price, shares: order.shares, amount: s.gross,
                   fee: s.fee + s.tax, total: s.net, pnl, pnlPct: cost > 0 ? pnl / cost : 0, idx: this.cur };
    this.shares = 0;
    this.costTotal = 0;
    this.log.push(fill); this.marks.push({ idx: this.cur, side: 'sell', price });
    this.events.push({ date, type: 'sell', text: `卖出 ${order.shares} 股 @ ${price.toFixed(2)}，盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} 元` });
    return fill;
  }

  /** 结束交易：还有下一日则按次日开盘价清仓，否则按最后收盘价结算 */
  endSession() {
    if (this.finished) return { ok: false, msg: '本轮训练已结束' };
    if (this.canAct && this.shares > 0) {
      const r = this.submit('sell');
      if (!r.ok) return r;              // 例如跌停卖不出
      if (this.finished) return { ok: true, settled: true };
      return { ok: true, settled: this.settle('manual') };
    }
    return { ok: true, settled: this.settle('manual') };
  }

  /** 结算：按当前（最后一日）收盘价把剩余持仓折算为现金 */
  settle(reason) {
    if (this.finished) return false;
    if (this.shares > 0) {
      const px = this.bars.close[this.cur];
      const s = sellProceeds(px, this.shares, this.fees);
      const pnl = s.net - this.costTotal;
      this.realized += pnl;
      if (pnl >= 0) this.wins += 1; else this.losses += 1;
      this.cash += s.net;
      this.totalFee += s.fee + s.tax;
      this.log.push({ side: 'settle', date: this.bars.dates[this.cur], price: px,
                      shares: this.shares, amount: s.gross, fee: s.fee + s.tax,
                      total: s.net, pnl, idx: this.cur });
      this.events.push({ date: this.bars.dates[this.cur], type: 'settle',
                         text: `按收盘价 ${px.toFixed(2)} 结算清仓` });
      this.shares = 0;
      this.costTotal = 0;
    }
    this.finished = true;
    this.settleReason = reason;
    this.curve.push({ idx: this.cur, equity: this.equity });
    return true;
  }

  /** 结果摘要 */
  summary() {
    const n = this.log.filter(t => t.side === 'buy').length;
    return {
      code: this.stock.code,
      name: this.stock.name,
      board: BOARDS[this.boardIdx],
      startDate: this.bars.dates[this.startIdx],
      endDate: this.bars.dates[this.cur],
      horizon: this.horizon,
      days: this.day,
      capital: this.capital,
      finalEquity: this.equity,
      returnPct: this.returnPct,
      realized: this.realized,
      totalFee: this.totalFee,
      buys: n,
      closes: this.wins + this.losses,
      wins: this.wins,
      losses: this.losses,
      winRate: this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : null,
      maxDrawdown: this.maxDrawdown,
      benchmarkPct: this.benchmarkPct,
      holding: this.shares > 0,
      settleReason: this.settleReason,
    };
  }
}
