# -*- coding: utf-8 -*-
"""前复权（forward adjustment）

口径
----
    除权因子 f(除权日) = (除权日前收盘 − 每股派现 + 配股价 × 每股配股)
                        / (除权日前收盘 × (1 + 每股送股 + 每股配股))

    前复权价(t) = 原始价(t) × Π_{除权日 > t} f(除权日)

即：最新价保持不变，历史价被等比缩放，除权造成的价格缺口被抹平。

事件来源
--------
G:/new_tdx/T0002/hq_cache/gbbq —— 通达信权息数据（category=1 为除权除息），
字段单位为「每 10 股」，故内部统一除以 10 转为每股。

缓存
----
每个标的的累计因子表缓存到 data/cache/adj/{code}.npz，gbbq 变更时删除即可。
"""
from __future__ import annotations

import os
from collections import defaultdict

import numpy as np

from . import tdx

GBBQ_PATH = os.environ.get("TDX_GBBQ", "/mnt/g/new_tdx/T0002/hq_cache/gbbq")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "cache", "adj")

_MARKET_ID = {"sz": 0, "sh": 1, "bj": 2}


# ---------------------------------------------------------------------------
# 权息事件
# ---------------------------------------------------------------------------

class Gbbq:
    """通达信 gbbq 权息事件表（全局只需加载一次）。"""

    _instance = None

    def __new__(cls, path: str = None):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._loaded = False
        return cls._instance

    def __init__(self, path: str = None):
        if self._loaded:
            return
        self.path = path or GBBQ_PATH
        self._load()
        self._loaded = True

    def _load(self):
        from pytdx.reader.gbbq_reader import GbbqReader

        df = GbbqReader().get_df(self.path)
        ev = df[df["category"] == 1]
        self.events = defaultdict(list)
        for r in ev.itertuples():
            code = str(r.code).zfill(6)
            self.events[(int(r.market), code)].append((
                int(r.datetime),
                float(r.hongli_panqianliutong),    # 每 10 股派现（元）
                float(r.songgu_qianzongguben),     # 每 10 股送股
                float(r.peigu_houzongguben),       # 每 10 股配股
                float(r.peigujia_qianzongguben),   # 配股价（元）
            ))
        for k in self.events:
            self.events[k].sort()
        self.n_events = int(len(ev))
        self.n_codes = int(ev["code"].nunique())

    def factors_at(self, code: str, prev_close: float, ex_date: int) -> float:
        """给定除权日前收盘，返回该次除权的单次因子（无效时返回 1.0）。"""
        mkt, c = tdx.normalize_code(code)
        out = 1.0
        for (dt, hl10, sg10, pg10, pp) in self.events.get((_MARKET_ID[mkt], c), []):
            if dt != ex_date:
                continue
            div, sg, pg = hl10 / 10.0, sg10 / 10.0, pg10 / 10.0
            f = (prev_close - div + pp * pg) / (prev_close * (1.0 + sg + pg))
            if 0.01 < f < 2.0:
                out *= f
        return out


# ---------------------------------------------------------------------------
# 单个标的的累计前复权因子
# ---------------------------------------------------------------------------

def daily_factors(code: str, gbbq: Gbbq = None, use_cache: bool = True):
    """基于【原始日线】计算每日累计前复权因子。

    返回 (dates: int64[YYYYMMDD], factors: float64)，与日线一一对应，升序。
    factors[-1] 恒为 1.0（最新价不变）。
    """
    mkt, c = tdx.normalize_code(code)
    key = mkt + c
    cache_p = os.path.join(CACHE_DIR, key + ".npz")
    if use_cache and os.path.isfile(cache_p):
        z = np.load(cache_p)
        return z["dates"], z["factors"]

    rec = tdx.read_day(key)
    if rec.size == 0:
        return np.zeros(0, "i8"), np.zeros(0, "f8")

    dates = rec["date"].astype("i8")
    close = rec["close"].astype("f8")
    factors = np.ones(dates.size, dtype="f8")

    gb = gbbq or Gbbq()
    evs = gb.events.get((_MARKET_ID[mkt], c), [])
    for (dt, hl10, sg10, pg10, pp) in evs:
        j = int(np.searchsorted(dates, dt))          # 除权日在日线中的位置
        if j <= 0 or j >= dates.size:
            continue                                  # 除权日不在数据范围内
        pc = close[j - 1]
        if pc <= 1e-6:
            continue
        div, sg, pg = hl10 / 10.0, sg10 / 10.0, pg10 / 10.0
        f = (pc - div + pp * pg) / (pc * (1.0 + sg + pg))
        if not (0.01 < f < 2.0):
            continue
        factors[:j] *= f                              # 除权日「之前」的全部日期

    if use_cache:
        os.makedirs(CACHE_DIR, exist_ok=True)
        np.savez_compressed(cache_p, dates=dates, factors=factors)
    return dates, factors


def daily_map(code: str, gbbq: Gbbq = None, use_cache: bool = True) -> dict:
    """{YYYYMMDD: 累计前复权因子}"""
    dates, factors = daily_factors(code, gbbq, use_cache)
    return {int(d): float(f) for d, f in zip(dates, factors)}


# ---------------------------------------------------------------------------
# 应用前复权
# ---------------------------------------------------------------------------

_PRICE_FIELDS = ("open", "high", "low", "close")


def apply_daily(rec: np.ndarray, factors: np.ndarray) -> np.ndarray:
    """对日线记录做前复权，返回新的数组（只改价格，量额不变）。"""
    out = rec.copy()
    for f in _PRICE_FIELDS:
        out[f] = rec[f].astype("f8") * factors
    return out


def apply_min(bars: np.ndarray, factor_map: dict) -> np.ndarray:
    """对分钟线记录做前复权（按 bar 的日期查因子）。"""
    out = bars.copy()
    fac = np.array([factor_map.get(int(d), 1.0) for d in bars["date"]], dtype="f8")
    for f in _PRICE_FIELDS:
        out[f] = bars[f].astype("f8") * fac
    return out


def adjusted_daily(code: str, gbbq: Gbbq = None, start=None, end=None) -> np.ndarray:
    """读取并前复权的日线。"""
    rec = tdx.read_day(code, start=start, end=end)
    if rec.size == 0:
        return rec
    dates, factors = daily_factors(code, gbbq)
    if dates.size != 0:
        # 区间读取时按日期对齐因子
        fmap = {int(d): float(f) for d, f in zip(dates, factors)}
        fac = np.array([fmap.get(int(d), 1.0) for d in rec["date"]], dtype="f8")
    else:
        fac = np.ones(rec.size)
    return apply_daily(rec, fac)


def adjusted_min(code: str, kind: str = "lc5", gbbq: Gbbq = None,
                 start=None, end=None) -> np.ndarray:
    """读取并前复权的分钟线。"""
    bars = tdx.read_min(code, kind=kind, start=start, end=end)
    if bars.size == 0:
        return bars
    dates, factors = daily_factors(code, gbbq)
    fmap = {int(d): float(f) for d, f in zip(dates, factors)}
    return apply_min(bars, fmap)


if __name__ == "__main__":
    import sys
    gb = Gbbq()
    print(f"gbbq: {gb.n_events:,} 条除权除息  标的 {gb.n_codes:,}")
    code = sys.argv[1] if len(sys.argv) > 1 else "sh600000"
    d = tdx.read_day(code)
    a = adjusted_daily(code)
    dates, fac = daily_factors(code)
    print(f"{tdx.full_code(code)}: {d.size} 条，因子区间 {fac.min():.4f} ~ {fac.max():.4f}")
    print("最近 5 日  原始收盘 -> 前复权收盘")
    for i in range(max(0, d.size - 5), d.size):
        print(f"  {tdx.int_to_str(int(d['date'][i]))}  {d['close'][i]:8.3f} -> {a['close'][i]:8.3f}")
