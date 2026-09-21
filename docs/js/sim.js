/**
 * 训练仿真引擎 —— 纯逻辑，不依赖 DOM，可直接在 Node 里跑单元测试。
 *
 * 交易规则（页面「规则」面板同源展示）
 * ------------------------------------
 * 1. 初始资金默认 10 万元；现金 + 持仓市值 = 总资产，仓位 = 持仓市值 / 总资产。
 *    价格统一为「分」精度（decode.js 已取整），所以每笔都能用 成交价 × 股数 = 成交额 验算。
 * 2. 决策只能基于「已揭示的最后一根 K 线」及其之前的信息。
 * 3. 下单方式（两种口径一致）：加仓 / 减仓都先进**今日委托篮**，成交前可逐笔撤销，
 *    点「进入下一日」时**按输入顺序**统一结算。两种口径只差成交价：
 *      - fillMode='close' 尾盘：按**今日收盘价**成交（提交时价格已可见，属近似）；
 *      - fillMode='open'  严格：按**次日开盘价**成交（零未来信息）。
 * 4. 加减仓粒度：
 *      加仓 1/4 | 1/3 | 1/2  = 买入「当前总资产 × 比例」的股票（受可用现金约束）
 *      加到满仓              = 用全部可用现金买入
 *      减仓 1/4 | 1/3 | 1/2  = 卖出「当前可卖持仓 × 比例」，按一手 100 股向下取整
 *      清仓                  = 卖出全部可卖持仓
 * 5. T+1：同一批委托里刚买入的股票，当批不能再卖出（成交时按"总持仓 − 本批已买入"重算可卖量）。
 * 6. 涨跌停：成交价触及涨停买不进、触及跌停卖不出（主板 10%，创业板/科创板 20%）。
 * 7. 走满 30/60/90 个交易日自动结算；「结束交易」尾盘模式按当收即时清仓，
 *    严格模式放弃今日委托并以次日开盘价清仓。
 * 8. 交易费用（可关闭）：佣金万 2.5（单笔最低 5 元）+ 过户费万 0.1，
 *    卖出另收印花税千 0.5。
 */

export const BOARDS = ['主板', '创业板', '科创板'];
export const LIMIT_PCT = [0.10, 0.20, 0.20];
export const LOT_SIZE = 100;
export const PRE_BARS = 60;         // 随机日期之前展示的「3 个月」≈ 60 个交易日
export const MIN_LISTED = 250;      // 次新股：上市不足 250 个交易日的样本不抽
export const MAX_GAP_DAYS = 15;     // 相邻 K 线自然日间隔上限（用于跳过长期停牌）
export const FEE = { commission: 0.00025, minCommission: 5, transfer: 0.00001, stamp: 0.0005 };

/** 成交口径 */
export const FILL_MODES = [
  { v: 'close', label: '尾盘即时成交', short: '尾盘价' },
  { v: 'open', label: '次日开盘价成交', short: '次开价' },
];

export function round2(x) { return Math.round(x * 100) / 100; }

/**
 * 按「一手 100 股」向下取整。
 * 浮点误差会让 3000 × (1/3) = 999.9999999999999，直接 floor 会少卖一手
 * （UI 若传 0.3333333333 这种截断小数更明显，持仓 300 股时甚至会变成卖 0 股）。
 * 这里加一个只对「贴着手数边界」生效的极小量修正。
 */
export function lotFloor(shares) {
  return Math.floor(shares / LOT_SIZE + 1e-6) * LOT_SIZE;
}

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
   * @param {number} o.position  默认仓位 1 / 0.5 / 1/3 / 0.25（仅用于界面高亮）
   * @param {string} o.fillMode  'close' 尾盘即时 | 'open' 次日开盘
   */
  constructor({ bars, stock, startIdx, horizon, position = 1, capital = 100000,
                fees = true, fillMode = 'close' }) {
    this.bars = bars;
    this.stock = stock;
    this.startIdx = startIdx;
    this.horizon = horizon;
    this.position = position;
    this.capital = capital;
    this.fees = fees;
    this.fillMode = fillMode === 'open' ? 'open' : 'close';
    this.boardIdx = stock.boardIdx ?? 0;

    this.cur = startIdx;
    this.lastIdx = Math.min(startIdx + horizon, bars.n - 1);
    this.day = 0;

    this.cash = capital;
    this.shares = 0;
    this.costTotal = 0;      // 当前持仓的买入成本（含费用）
    this.boughtToday = 0;    // 当日买入股数（尾盘模式的 T+1 约束）
    this.realized = 0;       // 已实现盈亏（已扣费用）
    this.totalFee = 0;

    this.pending = [];       // 严格模式的今日委托篮
    this._seq = 0;

    this.log = [];           // 成交流水
    this.events = [];        // 提示信息
    this.marks = [];         // 图上标记 {idx, side, price, shares, seq}
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
  /** 仓位 = 持仓市值 / 总资产 */
  get positionPct() { return this.equity > 0 ? this.marketValue / this.equity : 0; }
  /** 可卖股数。尾盘模式受 T+1 约束（当日买入的不能卖）；
   *  严格模式的委托本来就在次日开盘成交，天然满足 T+1，故全部可卖。 */
  get sellableShares() {
    return this.fillMode === 'open' ? this.shares : Math.max(0, this.shares - this.boughtToday);
  }
  /** 委托篮里已排队的卖出股数 */
  get queuedSellShares() { return this.pending.filter(o => o.side === 'sell').reduce((a, o) => a + o.shares, 0); }
  get canAct() { return !this.finished && this.day < this.horizon && this.cur < this.lastIdx; }
  get nextDate() { return this.cur < this.lastIdx ? this.bars.dates[this.cur + 1] : null; }
  /** 同期个股涨跌：从「随机日期收盘」到最后一日收盘（中性市场参照） */
  get benchmarkPct() { return this.price / this.bars.close[this.startIdx] - 1; }
  /** 满仓持有收益：用玩家能成交的第一个价格（随机日次日开盘）买入并持有，
   *  这才是与玩家收益率 apples-to-apples 的基准 */
  get buyHoldPct() {
    const i = Math.min(this.startIdx + 1, this.bars.n - 1);
    const p0 = this.bars.open[i];
    return p0 > 0 ? this.price / p0 - 1 : 0;
  }
  get progress() { return this.day / this.horizon; }
  get daysLeft() { return Math.max(0, this.horizon - this.day); }
  get fillModeLabel() { return (FILL_MODES.find(m => m.v === this.fillMode) || FILL_MODES[0]).label; }
  get shortFillLabel() { return (FILL_MODES.find(m => m.v === this.fillMode) || FILL_MODES[0]).short; }

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

  // ---- 下单意图 ----------------------------------------------------------
  /**
   * 计算一笔委托的意图（不成交、不推进）。
   * @param {'add'|'full'|'reduce'|'clear'} type
   * @param {number} fraction
   * @returns {{ok:boolean, code?:string, msg?:string, order?:object}}
   */
  plan(type, fraction = 1) {
    if (!this.canAct) return { ok: false, code: 'finished', msg: '本轮训练已结束，不能再操作' };
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const id = ++this._seq;

    if (type === 'add' || type === 'full') {
      // 入篮前先粗判一次，避免"点了一堆、过了一天才告诉你买不起"
      //   尾盘口径：成交价已知（今日收盘价），可以精确判断
      //   开盘口径：成交价未知，用"次日跌停价"这个最便宜的极端情况判断，
      //             只有连它都买不起才拦下来（否则可能误杀跳空低开才买得起的委托）
      const est = this.fillMode === 'close'
        ? this.bars.close[this.cur]
        : limitDownOf(this.bars.close[this.cur], this.boardIdx);
      const perLot = est * LOT_SIZE * (this.fees ? 1 + FEE.commission + FEE.transfer : 1);
      // 同批已挂的卖出委托会回款，也要算进可用资金（否则「清仓 + 买回」会被误拦）
      const queuedSell = this.pending.reduce((a, o) => a + (o.side === 'sell' ? o.shares : 0), 0);
      const avail = this.cash + queuedSell * est;
      if (avail < perLot) {
        return { ok: false, code: 'noFunds',
                 msg: `可用资金 ${Math.round(this.cash)} 元，不足一手（100 股 ≈ ${Math.round(est * LOT_SIZE)} 元` +
                      (this.fillMode === 'close' ? '）' : '，已按次日跌停价估算）') };
      }
      const full = type === 'full' || f >= 0.999999;
      // budget 只是「意图额度」，成交时再与当时的可用现金取小
      // （这样「清仓 + 买回」这类换仓委托也能成立）
      const budget = full ? null : Math.max(0, this.equity * f);
      const label = full ? '满仓' : `加 ${fracLabel(f)}`;
      return { ok: true, order: { id, side: 'buy', kind: full ? 'full' : 'add', fraction: f, budget, label } };
    }
    if (type === 'reduce' || type === 'clear') {
      const base = this.sellableShares - this.queuedSellShares;
      const clear = type === 'clear' || f >= 0.999999;
      if (this.shares <= 0) return { ok: false, code: 'noPosition', msg: '当前没有持仓' };
      if (base <= 0) {
        return { ok: false, code: 't1', msg: this.boughtToday > 0
          ? '当日买入的股票 T+1 才能卖，明天再操作'
          : '今天的可卖持仓已经全部委托出去了' };
      }
      let shares = clear ? base : lotFloor(base * f);
      if (shares <= 0) {
        return { ok: false, code: 'tooSmall',
                 msg: `减 ${fracLabel(f)} 不足 100 股（可卖 ${base} 股），请用「清仓」` };
      }
      const label = clear ? '清仓' : `减 ${fracLabel(f)}`;
      return { ok: true, order: { id, side: 'sell', kind: clear ? 'clear' : 'reduce', fraction: f, shares, label } };
    }
    return { ok: false, code: 'badType', msg: '未知的委托类型' };
  }

  /**
   * 下单 —— 一律进入「今日委托」篮，**点「进入下一日」时才统一结算**。
   * 两种口径只差成交价：
   *   尾盘即时成交 close：按「今日收盘价」成交（提交时价格已可见）
   *   次日开盘价成交 open：按「次日开盘价」成交
   * 委托在进入下一日之前都可以撤销，且**严格按输入顺序处理**。
   */
  order(type, fraction = 1) {
    const p = this.plan(type, fraction);
    if (!p.ok) return p;
    this.pending.push(p.order);
    return { ok: true, queued: true, order: p.order };
  }

  /** 撤销今日委托 */
  cancelOrder(id) {
    const i = this.pending.findIndex(o => o.id === id);
    if (i < 0) return { ok: false, msg: '委托不存在' };
    this.pending.splice(i, 1);
    return { ok: true };
  }

  clearPending() { this.pending = []; }

  // ---- 推进 --------------------------------------------------------------
  /**
   * 进入下一日 —— 今日委托篮在这里统一结算，**严格按输入顺序**逐笔处理。
   *   尾盘口径：先按「今日收盘价」成交，再推进到下一日；
   *   开盘口径：先推进到下一日，再按「次日开盘价」成交。
   */
  nextDay() {
    if (!this.canAct) return { ok: false, code: 'finished', msg: '本轮训练已结束' };
    const fills = [], rejects = [];
    const run = (price, idx) => {
      for (const o of this.pending) {          // 输入顺序，不做先卖后买的重排
        const r = this._fill(o, price, idx);
        if (r.ok) fills.push(r.fill);
        else rejects.push({ order: o, code: r.code, msg: r.msg });
      }
      this.pending = [];
    };

    if (this.fillMode === 'close') run(this.bars.close[this.cur], this.cur);
    this.cur += 1;
    this.day += 1;
    this.boughtToday = 0;
    if (this.fillMode === 'open' && this.pending.length) run(this.bars.open[this.cur], this.cur);

    this.curve.push({ idx: this.cur, equity: this.equity });
    let auto = false;
    if (this.day >= this.horizon) { this.settle('horizon'); auto = true; }
    return { ok: true, fills, rejects, auto, barIdx: this.cur };
  }

  _fill(order, price, idx) {
    const lim = this.limitsAt(idx);
    const EPS = 0.005;
    const date = this.bars.dates[idx];

    if (order.side === 'buy') {
      if (price >= lim.up - EPS) {
        this.events.push({ date, type: 'warn', text: `涨停封板（${price.toFixed(2)}），买入委托未成交` });
        return { ok: false, code: 'limitUp', msg: `${date} 涨停开盘/封板，买不进` };
      }
      if (this.cash <= 0) return { ok: false, code: 'noFunds', msg: '没有可用资金' };
      const budget = order.kind === 'full' ? this.cash
        : Math.min(this.cash, order.budget != null ? order.budget : this.cash);
      const perLot = price * LOT_SIZE;
      const perLotCost = this.fees ? perLot * (1 + FEE.commission + FEE.transfer) : perLot;
      // budget/perLotCost 是「手数」，乘回 100 换算成股数再按手取整
      let shares = perLotCost > 0 ? lotFloor(budget / perLotCost * LOT_SIZE) : 0;
      while (shares > 0 && buyCost(price, shares, this.fees).total > this.cash + 1e-6) shares -= LOT_SIZE;
      if (shares <= 0) {
        return { ok: false, code: 'noFunds',
                 msg: `可用资金 ${Math.round(this.cash)} 元，不足一手（100 股 ≈ ${Math.round(perLot)} 元）` };
      }
      const c = buyCost(price, shares, this.fees);
      this.cash -= c.total;
      this.costTotal += c.total;
      this.shares += shares;
      this.boughtToday += shares;
      this.totalFee += c.fee;
      const fill = { seq: order.id || ++this._seq, side: 'buy', label: order.label, date, price,
                     shares, amount: c.gross, fee: c.fee, total: c.total, idx,
                     ...this._snapAfter(price) };
      this.log.push(fill);
      this.marks.push({ idx, side: 'buy', price, seq: fill.seq });
      this.events.push({ date, type: 'buy', text: `${order.label}：买入 ${shares} 股 @ ${price.toFixed(2)}` });
      return { ok: true, fill };
    }

    // 卖出：数量在**成交那一刻**按实时可卖持仓重算（plan 时的股数只作预估）
    // 可卖 = 总持仓 − 本批已买入（T+1：同一批里刚买的当日不能卖）
    if (price <= lim.down + EPS) {
      this.events.push({ date, type: 'warn', text: `跌停封板（${price.toFixed(2)}），卖出委托未成交` });
      return { ok: false, code: 'limitDown', msg: `${date} 跌停封板，卖不出` };
    }
    const base = Math.max(0, this.shares - this.boughtToday);
    if (base <= 0) {
      return { ok: false, code: 't1',
               msg: this.boughtToday > 0 ? '本批买入的股票 T+1 才能卖' : '没有可卖持仓' };
    }
    let sh = order.kind === 'clear' ? base : lotFloor(base * order.fraction);
    sh = Math.min(sh, base);
    if (sh <= 0) return { ok: false, code: 'noPosition', msg: '没有可卖持仓' };
    const s = sellProceeds(price, sh, this.fees);
    const cost = this.costTotal * (sh / this.shares);
    const pnl = s.net - cost;
    this.realized += pnl;
    if (pnl >= 0) this.wins += 1; else this.losses += 1;
    this.cash += s.net;
    this.costTotal -= cost;
    this.shares -= sh;
    this.totalFee += s.fee + s.tax;
    const fill = { seq: order.id || ++this._seq, side: 'sell', label: order.label, date, price,
                   shares: sh, amount: s.gross, fee: s.fee + s.tax, total: s.net,
                   pnl, pnlPct: cost > 0 ? pnl / cost : 0, idx, ...this._snapAfter(price) };
    this.log.push(fill);
    this.marks.push({ idx, side: 'sell', price, seq: fill.seq });
    this.events.push({ date, type: 'sell',
      text: `${order.label}：卖出 ${sh} 股 @ ${price.toFixed(2)}，盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)} 元` });
    return { ok: true, fill };
  }

  // ---- 收尾 --------------------------------------------------------------
  /** 结束交易 */
  endSession() {
    if (this.finished) return { ok: false, msg: '本轮训练已结束' };
    if (this.fillMode === 'close') {
      const dropped = this.pending.length;
      return { ok: true, settled: this.settle('manual'), drops: dropped };
    }
    if (this.canAct && this.shares > 0) {
      const dropped = this.pending.length;
      this.clearPending();                 // 放弃今日未成交委托
      const r = this.order('clear');       // 入篮：次日开盘清仓
      if (!r.ok) return r;
      const n = this.nextDay();
      if (n.rejects && n.rejects.length) {
        // 次日跌停卖不掉 → 按最后收盘价结算
        return { ok: true, settled: this.settle('manual'), drops: dropped, rejected: n.rejects };
      }
      if (this.finished) return { ok: true, settled: true, drops: dropped };
      return { ok: true, settled: this.settle('manual'), drops: dropped };
    }
    return { ok: true, settled: this.settle('manual') };
  }

  /** 结算：按当前（最后一日）收盘价把剩余持仓折算为现金 */
  settle(reason) {
    if (this.finished) return false;
    if (this.shares > 0) {
      const px = this.bars.close[this.cur];
      const sh0 = this.shares, cost0 = this.costTotal;
      const s = sellProceeds(px, sh0, this.fees);
      const pnl = s.net - cost0;
      this.realized += pnl;
      if (pnl >= 0) this.wins += 1; else this.losses += 1;
      this.cash += s.net;
      this.totalFee += s.fee + s.tax;
      this.shares = 0;
      this.costTotal = 0;
      // 快照要取「清仓之后」的状态，所以放在 shares 归零之后
      const fill = { seq: ++this._seq, side: 'settle', label: '结算', date: this.bars.dates[this.cur],
                     price: px, shares: sh0, amount: s.gross, fee: s.fee + s.tax,
                     total: s.net, pnl, pnlPct: cost0 > 0 ? pnl / cost0 : 0,
                     idx: this.cur, ...this._snapAfter(px) };
      this.log.push(fill);
      this.marks.push({ idx: this.cur, side: 'sell', price: px, seq: fill.seq, settle: true });
      this.events.push({ date: this.bars.dates[this.cur], type: 'settle',
                         text: `按收盘价 ${px.toFixed(2)} 结算清仓` });
    }
    this.finished = true;
    this.settleReason = reason;
    this.pending = [];
    this.curve.push({ idx: this.cur, equity: this.equity });
    return true;
  }

  /** 成交后立刻记账的快照（用成交价 mark，用于成交流水表的「成交后」各列） */
  _snapAfter(price) {
    const equity = this.cash + this.shares * price;
    return {
      cashAfter: this.cash,
      sharesAfter: this.shares,
      costAfter: this.shares > 0 ? this.costTotal / this.shares : 0,
      equityAfter: equity,
      returnAfter: equity / this.capital - 1,
      realizedAfter: this.realized,
      feeAfter: this.totalFee,
      positionAfter: equity > 0 ? this.shares * price / equity : 0,
    };
  }

  /** 结果摘要 */
  summary() {
    const buys = this.log.filter(t => t.side === 'buy');
    const sells = this.log.filter(t => t.side === 'sell' || t.side === 'settle');
    return {
      code: this.stock.code,
      name: this.stock.name,
      board: BOARDS[this.boardIdx],
      startDate: this.bars.dates[this.startIdx],
      endDate: this.bars.dates[this.cur],
      horizon: this.horizon,
      fillMode: this.fillMode,
      fillModeLabel: this.fillModeLabel,
      days: this.day,
      capital: this.capital,
      finalEquity: this.equity,
      returnPct: this.returnPct,
      realized: this.realized,
      totalFee: this.totalFee,
      buys: buys.length,
      closes: sells.length,
      wins: this.wins,
      losses: this.losses,
      winRate: this.wins + this.losses > 0 ? this.wins / (this.wins + this.losses) : null,
      maxDrawdown: this.maxDrawdown,
      benchmarkPct: this.benchmarkPct,
      buyHoldPct: this.buyHoldPct,
      holding: this.shares > 0,
      settleReason: this.settleReason,
    };
  }
}

/** 0.25 -> '1/4'；0.5 -> '1/2'；0.3333 -> '1/3' */
export function fracLabel(f) {
  if (f >= 0.999999) return '满仓';
  for (const [v, l] of [[0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2']]) {
    if (Math.abs(f - v) < 0.02) return l;
  }
  return (f * 100).toFixed(0) + '%';
}
