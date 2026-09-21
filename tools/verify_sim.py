# -*- coding: utf-8 -*-
"""股数 / 资金 / 收益率对账：用**独立实现**重放前端引擎跑出来的交易流水。

流程
----
1. 调 node tools/gen_transcript.mjs 生成流水（真实 .bin + 前端 sim.js）；
2. 本文件按同一动作序列，用自己写的记账代码从 .bin 重算一遍；
3. 逐步比对 现金 / 持仓股数 / 持仓成本 / 总资产 / 收益率 / 已实现盈亏 / 累计费用；
4. 再独立校验若干恒等式：
     * 每笔买入股数都是 100 的整数倍，且含费用的总支出不超过成交前现金
     * 费用 = max(5, 成交额×0.00025) + 成交额×0.00001（卖出再加成交额×0.0005）
     * 总资产 = 现金 + 持仓市值
     * 总资产 − 初始资金 == 已实现盈亏 + 浮动盈亏（成本基准分摊正确性的充要校验）
     * 收益率 == 总资产 / 初始资金 − 1
     * 卖出的成本基准按股数比例分摊

用法： python tools/verify_sim.py [股票数=6]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from tools.build_data import decode_pack  # noqa: E402

LOT = 100
COMM = 0.00025
MIN_COMM = 5.0
TRANSFER = 0.00001
STAMP = 0.0005
LIMIT_PCT = (0.10, 0.20, 0.20)      # 主板 / 创业板 / 科创板
TOL = 1e-6


def lot_floor(shares: float) -> int:
    """与前端 lotFloor 同口径：按手向下取整，容忍浮点误差。"""
    return int(np.floor(shares / LOT + 1e-6)) * LOT


def buy_fee(gross: float) -> float:
    return max(MIN_COMM, gross * COMM) + gross * TRANSFER


def sell_fee(gross: float) -> float:
    return max(MIN_COMM, gross * COMM) + gross * TRANSFER + gross * STAMP


class Replay:
    """独立记账实现（不 import 前端任何代码）。"""

    def __init__(self, bars: dict, start: int, horizon: int, fill_mode: str, capital: float,
                 board_idx: int = 0):
        self.board = board_idx
        self.b = bars
        self.cur = start
        self.horizon = horizon
        self.days = 0
        self.mode = fill_mode
        self.capital = capital
        self.cash = capital
        self.shares = 0
        self.cost_total = 0.0
        self.bought_today = 0
        self.realized = 0.0
        self.total_fee = 0.0
        self.pending: list = []
        self.finished = False
        self.n_buys = 0
        self.n_sells = 0
        self.bad: list = []

    # -- 状态 --
    @property
    def price(self): return float(self.b["close"][self.cur])
    @property
    def equity(self): return self.cash + self.shares * self.price
    @property
    def avg_cost(self): return self.cost_total / self.shares if self.shares else 0.0
    @property
    def position_pct(self): return (self.shares * self.price) / self.equity if self.equity else 0.0
    @property
    def return_pct(self): return self.equity / self.capital - 1.0
    @property
    def sellable(self):
        return self.shares if self.mode == "open" else max(0, self.shares - self.bought_today)

    def limit_up(self, idx):
        return round(float(self.b["close"][idx - 1]) * (1 + LIMIT_PCT[self.board]), 2)

    def limit_down(self, idx):
        return round(float(self.b["close"][idx - 1]) * (1 - LIMIT_PCT[self.board]), 2)

    # -- 下单 --
    def plan(self, kind, frac):
        if self.finished or self.days >= self.horizon or self.cur >= self.start_last:
            return None
        if kind in ("add", "full"):
            est = (float(self.b["close"][self.cur]) if self.mode == "close"
                   else round(float(self.b["close"][self.cur]) * 0.9, 2))
            queued_sell = sum(o["shares"] for o in self.pending if o["side"] == "sell")
            if self.cash + queued_sell * est < est * LOT * (1 + COMM + TRANSFER):
                return None                      # 入篮前买不起一手，直接拒绝
            full = kind == "full" or frac >= 0.999999
            budget = None if full else max(0.0, self.equity * frac)
            return {"side": "buy", "kind": "full" if full else "add", "budget": budget,
                    "shares": None, "label": "满仓" if full else "加", "fraction": frac}
        base = self.sellable - sum(o["shares"] for o in self.pending if o["side"] == "sell")
        if self.shares <= 0 or base <= 0:
            return None
        clear = kind == "clear" or frac >= 0.999999
        sh = base if clear else lot_floor(base * frac)
        if sh <= 0:
            return None
        # 只是入篮前的预估，真正卖多少在成交时按实时可卖重算
        return {"side": "sell", "kind": "clear" if clear else "reduce", "shares": sh,
                "budget": None, "label": "清仓" if clear else "减", "fraction": frac}

    def order(self, kind, frac):
        o = self.plan(kind, frac)
        if o is None:
            return {"ok": False}
        self.pending.append(o)
        return {"ok": True, "queued": True, "order": o}

    def cancel(self):
        if self.pending:
            self.pending.pop(0)
            return {"ok": True}
        return {"ok": True, "noop": True}

    def check_buy(self, price, shares, cash_before, fee):
        if shares % LOT != 0:
            self.bad.append(f"买入股数 {shares} 不是 100 的整数倍")
        total = price * shares + fee          # 必须用**成交价**，不是当日收盘价
        if total > cash_before + TOL:
            self.bad.append(f"买入支出 {total:.6f} 超过成交前现金 {cash_before:.6f}")

    def _fill(self, o, price, idx):
        if o["side"] == "buy":
            if price >= self.limit_up(idx) - 0.005:
                return None
            if self.cash <= 0:
                return None
            budget = self.cash if o["kind"] == "full" else min(self.cash, o["budget"])
            per_lot = price * LOT
            per_lot_cost = per_lot * (1 + COMM + TRANSFER)
            # budget/per_lot_cost 是手数，乘回 100 才是股数
            sh = lot_floor(budget / per_lot_cost * LOT) if per_lot_cost > 0 else 0
            while sh > 0 and price * sh + buy_fee(price * sh) > self.cash + TOL:
                sh -= LOT
            if sh <= 0:
                return None
            gross = price * sh
            fee = buy_fee(gross)
            self.check_buy(price, sh, self.cash, fee)
            self.cash -= gross + fee
            self.cost_total += gross + fee
            self.shares += sh
            self.bought_today += sh
            self.total_fee += fee
            self.n_buys += 1
            return {"side": "buy", "price": price, "shares": sh, "gross": gross, "fee": fee}
        # 卖出
        if price <= self.limit_down(idx) + 0.005:
            return None
        base = max(0, self.shares - self.bought_today)
        if base <= 0:
            return None
        sh = base if o["kind"] == "clear" else lot_floor(base * o["fraction"])
        sh = min(sh, base)
        if sh <= 0:
            return None
        gross = price * sh
        fee = sell_fee(gross)
        net = gross - fee
        cost = self.cost_total * (sh / self.shares)
        pnl = net - cost
        self.cash += net
        self.cost_total -= cost
        self.shares -= sh
        self.realized += pnl
        self.total_fee += fee
        self.n_sells += 1
        return {"side": "sell", "price": price, "shares": sh, "gross": gross, "fee": fee, "pnl": pnl}

    def _run_batch(self, price, idx):
        for o in self.pending:               # 严格按输入顺序
            self._fill(o, price, idx)
        self.pending = []

    def next_day(self):
        if self.finished or self.days >= self.horizon or self.cur >= self.start_last:
            return
        if self.mode == "close" and self.pending:
            self._run_batch(float(self.b["close"][self.cur]), self.cur)   # 尾盘：先用今收
        self.cur += 1
        self.days += 1
        self.bought_today = 0
        if self.mode == "open" and self.pending:
            self._run_batch(float(self.b["open"][self.cur]), self.cur)    # 严格：先用次开
        if self.days >= self.horizon:
            self.settle()

    def settle(self):
        if self.finished:
            return
        if self.shares > 0:
            px = self.price
            gross = px * self.shares
            fee = sell_fee(gross)
            cost = self.cost_total
            pnl = gross - fee - cost
            self.cash += gross - fee
            self.realized += pnl
            self.total_fee += fee
            self.shares = 0
            self.cost_total = 0.0
        self.finished = True


# ---------------------------------------------------------------------------
def verify_one(tag, transcript_path, bin_path):
    T = json.load(open(transcript_path, encoding="utf-8"))
    bars = decode_pack(open(bin_path, "rb").read())
    r = Replay(bars, T["startIdx"], T["horizon"], T["fillMode"], T["capital"], T.get("boardIdx", 0))
    r.start_last = min(T["startIdx"] + T["horizon"], bars["dates"].size - 1)

    bad = []
    checked = 0
    for step in T["steps"]:
        a = step["action"]
        if a["type"] == "order":
            frac = 1.0
            if a.get("frac"):
                p = a["frac"].split("/")
                frac = int(p[0]) / int(p[1]) if len(p) == 2 else float(a["frac"])
            r.order(a["kind"], frac)
        elif a["type"] == "cancel":
            r.cancel()
        else:
            r.next_day()

        exp = step["state"]
        # 引擎被拒时状态不变，这里也应当不变
        cmp = {
            "现金": (r.cash, exp["cash"]),
            "股数": (r.shares, exp["shares"]),
            "持仓成本": (r.cost_total, exp["costTotal"]),
            "总资产": (r.equity, exp["equity"]),
            "收益率": (r.return_pct, exp["returnPct"]),
            "已实现盈亏": (r.realized, exp["realized"]),
            "累计费用": (r.total_fee, exp["totalFee"]),
            "可卖股数": (r.sellable, exp["sellable"]),
            "日期下标": (r.cur, exp["cur"]),
        }
        for name, (mine, theirs) in cmp.items():
            checked += 1
            if name == "日期下标":
                if mine != theirs:
                    bad.append(f"第{step['i']}步 {a} {name}: 独立={mine} 引擎={theirs}")
                continue
            scale = max(1.0, abs(theirs))
            if abs(mine - theirs) > TOL * scale:
                bad.append(f"第{step['i']}步 {a} {name}: 独立={mine:.8f} 引擎={theirs:.8f} 差={mine-theirs:.3e}")
        # 平仓流水里的费用与盈亏
        if step.get("fill"):
            f = step["fill"]
            gross = f["price"] * f["shares"]
            want_fee = buy_fee(gross) if f["side"] == "buy" else sell_fee(gross)
            if abs(want_fee - f["fee"]) > 1e-6:
                bad.append(f"第{step['i']}步 费用不符: 按公式={want_fee:.6f} 引擎={f['fee']:.6f}")

    # 恒等式
    if abs((r.equity - r.capital) - (r.realized + (r.shares * r.price - r.cost_total))) > 1e-6:
        bad.append("恒等式失败: 总资产−本金 != 已实现 + 浮动")
    if abs(r.return_pct - (r.equity / r.capital - 1)) > 1e-12:
        bad.append("收益率 != 总资产/本金 − 1")
    if abs(r.equity - (r.cash + r.shares * r.price)) > 1e-9:
        bad.append("总资产 != 现金 + 持仓市值")
    bad.extend(r.bad)

    S = T["summary"]
    if abs(r.equity - S["finalEquity"]) > 1e-6:
        bad.append(f"最终总资产: 独立={r.equity:.6f} 引擎={S['finalEquity']:.6f}")
    if abs(r.return_pct - S["returnPct"]) > 1e-12:
        bad.append(f"最终收益率: 独立={r.return_pct:.10f} 引擎={S['returnPct']:.10f}")
    if abs(r.realized - S["realized"]) > 1e-6:
        bad.append(f"已实现盈亏: 独立={r.realized:.6f} 引擎={S['realized']:.6f}")
    if abs(r.total_fee - S["totalFee"]) > 1e-6:
        bad.append(f"累计费用: 独立={r.total_fee:.6f} 引擎={S['totalFee']:.6f}")
    if abs(r.cash - S["finalEquity"]) > 1e-6:
        bad.append("结算后现金 != 总资产")

    print(f"  {tag:<34} 步数 {len(T['steps']):>3}  成交 {r.n_buys}买/{r.n_sells}卖  "
          f"最终 {r.equity:>12,.2f}  收益率 {r.return_pct*100:>+7.2f}%  "
          f"{'OK' if not bad else '❌ ' + str(len(bad)) + ' 处不符'}")
    for m in bad[:6]:
        print("      -", m)
    return bad, checked


def main(n=6):
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "index.json"), encoding="utf-8"))
    stocks = idx["stocks"]
    rng = np.random.default_rng(7)
    picks = [stocks[i] for i in rng.choice(len(stocks), size=n, replace=False)]
    total_bad, total_checked = [], 0
    print(f"对账样本：{n} 只股票 × 2 种成交口径\n")
    with tempfile.TemporaryDirectory() as td:
        for s in picks:
            code, name = s[0], s[1]
            for mode in ("close", "open"):
                out = os.path.join(td, f"{code}_{mode}.json")
                subprocess.run(["node", os.path.join(HERE, "gen_transcript.mjs"),
                                code, "150", "30", mode, out],
                               check=True, capture_output=True, cwd=ROOT)
                bad, checked = verify_one(f"{name} {code[2:]} [{mode}]", out,
                                          os.path.join(ROOT, "docs", "data", code[2:] + ".bin"))
                total_bad += bad
                total_checked += checked
    print(f"\n共比对 {total_checked:,} 个数值（现金/股数/成本/总资产/收益率/盈亏/费用/可卖）")
    if total_bad:
        print(f"❌ 发现 {len(total_bad)} 处不一致")
        return 1
    print("✅ 全部一致：股数、资金、成本基准、收益率、费用与前端引擎完全对得上")
    return 0


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 6))
