# -*- coding: utf-8 -*-
"""通达信本地数据读取层（日线 .day / 五分钟 .lc5 / 一分钟 .lc1）

数据源（全部为【不复权】原始价，前复权见 src/adj.py）：
    日线     G:/new_tdx/vipdoc/{sh,sz,bj}/lday/*.day
    五分钟   G:/new_tdx/vipdoc/{sh,sz,bj}/fzline/*.lc5
    一分钟   G:/new_tdx/vipdoc/{sh,sz,bj}/minline/*.lc1

交易日历：以 sh000001（上证指数）日线日期为基准。

文件格式
--------
.day  32 字节/条，小端：
    date u4 (YYYYMMDD) | open u4 | high u4 | low u4 | close u4 | amount f4(元) | vol u4(股) | rsv u4
    价格 = 整数值 / 100

.lc5 / .lc1  32 字节/条，小端：
    date u2 | time u2 | open f4 | high f4 | low f4 | close f4 | amount f4 | vol u4 | rsv u4
    date 解码: year = date//2048 + 2004; month = (date%2048)//100; day = date%2048%100
    time 解码: 自 00:00 起的分钟数（575 -> 09:35），每日 48 根 5 分钟线
"""
from __future__ import annotations

import os
import numpy as np

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

TDX_ROOT = os.environ.get("TDX_ROOT", "/mnt/g/new_tdx/vipdoc")
MARKETS = ("sh", "sz", "bj")

DAY_DTYPE = np.dtype([
    ("date", "<u4"), ("open", "<u4"), ("high", "<u4"), ("low", "<u4"),
    ("close", "<u4"), ("amount", "<f4"), ("vol", "<u4"), ("rsv", "<u4"),
])

MIN_DTYPE = np.dtype([
    ("date", "<u2"), ("time", "<u2"), ("open", "<f4"), ("high", "<f4"),
    ("low", "<f4"), ("close", "<f4"), ("amount", "<f4"), ("vol", "<u4"),
    ("rsv", "<u4"),
])

#: 读取后统一的日线结构（价格为 float 元）
DAILY_FIELDS = [("date", "i8"), ("open", "f8"), ("high", "f8"), ("low", "f8"),
                ("close", "f8"), ("amount", "f8"), ("vol", "f8")]

#: 读取后统一的分钟线结构
MIN_FIELDS = DAILY_FIELDS + [("time", "i4")]


def _empty_daily():
    return np.zeros(0, dtype=DAILY_FIELDS)


def _empty_min():
    return np.zeros(0, dtype=MIN_FIELDS)


# ---------------------------------------------------------------------------
# 代码 / 路径
# ---------------------------------------------------------------------------

def normalize_code(code: str):
    """'sh600000' / 'SH600000' / '600000' / 600000 -> ('sh', '600000')"""
    c = str(code).strip().lower()
    if len(c) > 2 and c[:2] in MARKETS:
        return c[:2], c[2:].zfill(6)
    c = c.zfill(6)
    if c[:2] in ("60", "68", "51", "58", "56", "50", "90"):
        return "sh", c
    if c[:2] in ("00", "30", "15", "16", "18", "12", "39", "20"):
        return "sz", c
    if c[:2] in ("43", "83", "87", "88", "92"):
        return "bj", c
    if c.startswith("9"):
        return "sh", c
    return "sz", c


def full_code(code: str) -> str:
    """'600000' -> 'sh600000'"""
    mkt, c = normalize_code(code)
    return mkt + c


def daily_path(code: str) -> str:
    mkt, c = normalize_code(code)
    return os.path.join(TDX_ROOT, mkt, "lday", f"{mkt}{c}.day")


def min_path(code: str, kind: str = "lc5") -> str:
    """.lc5 = 5 分钟（fzline）；.lc1 = 1 分钟（minline）"""
    mkt, c = normalize_code(code)
    sub = "fzline" if kind == "lc5" else "minline"
    return os.path.join(TDX_ROOT, mkt, sub, f"{mkt}{c}.{kind}")


def list_codes(market: str = None, kind: str = "lday") -> list:
    """列出本地存在的标的（'sh600000' 形式）。kind: lday / lc5 / lc1"""
    sub = {"lday": "lday", "lc5": "fzline", "lc1": "minline"}[kind]
    ext = {"lday": ".day", "lc5": ".lc5", "lc1": ".lc1"}[kind]
    mkts = [market] if market else list(MARKETS)
    out = []
    for mkt in mkts:
        d = os.path.join(TDX_ROOT, mkt, sub)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.endswith(ext):
                out.append(fn[: -len(ext)])
    return sorted(out)


# ---------------------------------------------------------------------------
# 日期辅助
# ---------------------------------------------------------------------------

def to_int_date(s) -> int:
    """'2026-09-18' / '20260918' / int -> 20260918"""
    if isinstance(s, (int, np.integer)):
        return int(s)
    return int(str(s).replace("-", "").replace("/", "").strip()[:8])


def int_to_str(d: int) -> str:
    """20260918 -> '2026-09-18'"""
    s = str(int(d))
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def decode_min_date(d) -> np.ndarray:
    """通达信压缩日期 (u2) -> YYYYMMDD (int32)"""
    d = np.asarray(d).astype(np.int32)
    return (d // 2048 + 2004) * 10000 + ((d % 2048) // 100) * 100 + (d % 2048 % 100)


def decode_min_time(t) -> np.ndarray:
    """分钟数 -> 'HH:MM' 字符串数组"""
    t = np.asarray(t).astype(np.int32)
    return np.array([f"{x // 60:02d}:{x % 60:02d}" for x in t])


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------

def _slice_by_date(dates, start, end):
    lo, hi = 0, len(dates)
    if start is not None:
        lo = int(np.searchsorted(dates, to_int_date(start), side="left"))
    if end is not None:
        hi = int(np.searchsorted(dates, to_int_date(end), side="right"))
    return lo, hi


def read_day(code: str = None, path: str = None, start=None, end=None) -> np.ndarray:
    """读取日线（不复权）。

    返回结构化数组，字段 date(i8 YYYYMMDD), open/high/low/close(f8 元),
    amount(f8 元), vol(f8 股)，按日期升序。
    """
    p = path or daily_path(code)
    if not os.path.isfile(p):
        return _empty_daily()
    raw = np.fromfile(p, dtype=DAY_DTYPE)
    if raw.size == 0:
        return _empty_daily()
    lo, hi = _slice_by_date(raw["date"], start, end)
    if lo >= hi:
        return _empty_daily()
    r = raw[lo:hi]
    out = np.empty(r.size, dtype=DAILY_FIELDS)
    out["date"] = r["date"].astype("i8")
    for f in ("open", "high", "low", "close"):
        out[f] = r[f] / 100.0
    out["amount"] = r["amount"].astype("f8")
    out["vol"] = r["vol"].astype("f8")
    return out


def read_min(code: str = None, path: str = None, kind: str = "lc5",
             start=None, end=None) -> np.ndarray:
    """读取 5 分钟(kind='lc5') / 1 分钟(kind='lc1') 数据（不复权）。

    返回字段 date(i8 YYYYMMDD), time(i4 分钟数), open/high/low/close(f8),
    amount(f8), vol(f8)，按时间升序。
    """
    p = path or min_path(code, kind)
    if not os.path.isfile(p):
        return _empty_min()
    raw = np.fromfile(p, dtype=MIN_DTYPE)
    if raw.size == 0:
        return _empty_min()
    dates = decode_min_date(raw["date"]).astype("i8")
    lo, hi = _slice_by_date(dates, start, end)
    if lo >= hi:
        return _empty_min()
    r = raw[lo:hi]
    out = np.empty(r.size, dtype=MIN_FIELDS)
    out["date"] = dates[lo:hi]
    out["time"] = r["time"].astype("i4")
    for f in ("open", "high", "low", "close"):
        out[f] = r[f].astype("f8")
    out["amount"] = r["amount"].astype("f8")
    out["vol"] = r["vol"].astype("f8")
    return out


def last_date(code: str) -> int:
    """快速取某标的日线的最后一个交易日（只读末尾 32 字节）。"""
    p = daily_path(code)
    size = os.path.getsize(p) if os.path.isfile(p) else 0
    if size < 32:
        return 0
    with open(p, "rb") as f:
        f.seek(size - 32)
        return int(np.frombuffer(f.read(4), dtype="<u4")[0])


def last_min_date(code: str, kind: str = "lc5") -> int:
    p = min_path(code, kind)
    size = os.path.getsize(p) if os.path.isfile(p) else 0
    if size < 32:
        return 0
    with open(p, "rb") as f:
        f.seek(size - 32)
        d = int(np.frombuffer(f.read(2), dtype="<u2")[0])
    return int(decode_min_date(np.array([d]))[0])


def trading_calendar(start=None, end=None, index: str = "sh000001") -> np.ndarray:
    """交易日历（int YYYYMMDD），以上证指数日线为准。"""
    rec = read_day(index, start=start, end=end)
    return rec["date"].astype("i8")


if __name__ == "__main__":
    import sys
    code = sys.argv[1] if len(sys.argv) > 1 else "sh600000"
    d = read_day(code)
    print(f"{full_code(code)} 日线 {len(d)} 条  {int_to_str(d['date'][0])} -> {int_to_str(d['date'][-1])}")
    m = read_min(code)
    print(f"{full_code(code)} 5分钟 {len(m)} 条  {int_to_str(m['date'][0])} {m['time'][0]} -> "
          f"{int_to_str(m['date'][-1])} {m['time'][-1]}")
