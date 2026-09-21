# -*- coding: utf-8 -*-
"""股票池（Universe）—— 已获用户许可的池规则实现。

用户 2026-09-20 批准：**全市场，剔除 ST / 退市 / 次新 / 基金**
（见 docs/02_选股条件登记表.md Q13）

本模块只实现"股票池"，不含任何选股条件。

资产类别判定
------------
按「市场 + 代码前缀」硬规则判定（不依赖未来信息），规则由
`scripts/verify_universe.py` 用通达信名称白名单实测得出。

⚠️ 两个必须知道的偏差
---------------------
1. **ST 只有当前快照**。通达信 `T0002/hq_cache/infoharbor_ex.code` 提供的是
   *今天* 的名称（如 `*ST美丽`），没有历史名称。用它做历史回测 = 引入未来信息：
   一只 2023 年才被 ST 的股票，在 2020 年的回测里也会被剔除。
   → `st_mode="current"` 时会在报告中显式警告；`st_mode="off"` 则不过滤 ST。
2. **上市日期 `SSDATE` 来自 `base.dbf` 当前快照**，退市股不在其中；
   对退市股回退为「本地日线第一根 bar 的日期」（近似，但不会引入未来信息）。

次新阈值 `min_list_days` **没有默认值**——该参数必须由用户给定（铁律 #2）。
未给定而要求剔除次新时，直接抛错，避免静默使用助手臆造的阈值。
"""
from __future__ import annotations

import os
import struct

import numpy as np

from . import tdx

HQ_CACHE = os.environ.get("TDX_HQ_CACHE", "/mnt/g/new_tdx/T0002/hq_cache")

#: 资产类别
ASSET_STOCK = "stock"
ASSET_FUND = "fund"
ASSET_BOND = "bond"
ASSET_INDEX = "index"
ASSET_OTHER = "other"

#: 板块
BOARD_MAIN = "主板"
BOARD_GEM = "创业板"
BOARD_STAR = "科创板"
BOARD_BJ = "北交所"
BOARD_B = "B股"


# ---------------------------------------------------------------------------
# 资产类别 / 板块（market, code6）-> (asset, board)
# ---------------------------------------------------------------------------

def classify(market: str, code6: str):
    m = market.lower()
    p3 = code6[:3]
    if m == "sh":
        if p3 in ("600", "601", "603", "605"):
            return ASSET_STOCK, BOARD_MAIN
        if p3 in ("688", "689"):
            return ASSET_STOCK, BOARD_STAR
        if p3 == "900":
            return ASSET_STOCK, BOARD_B
        if p3 in ("000", "999") or p3 in ("880", "881", "887", "888", "889"):
            return ASSET_INDEX, None
        if code6[0] == "5":
            return ASSET_FUND, None
        return ASSET_BOND, None
    if m == "sz":
        if p3 in ("000", "001", "002", "003"):
            return ASSET_STOCK, BOARD_MAIN
        if p3 in ("300", "301", "302"):
            return ASSET_STOCK, BOARD_GEM
        if p3 == "200":
            return ASSET_STOCK, BOARD_B
        if p3 in ("399", "395", "398"):
            return ASSET_INDEX, None
        if p3 in ("159", "158") or p3[:2] in ("15", "16", "17", "18"):
            return ASSET_FUND, None
        if p3[:2] in ("10", "11", "12", "13", "14"):
            return ASSET_BOND, None
        return ASSET_OTHER, None
    if m == "bj":
        if p3 in ("920", "430", "830", "831", "832", "833", "834", "835", "836",
                  "837", "838", "839", "870", "871", "872", "873", "874"):
            return ASSET_STOCK, BOARD_BJ
        return ASSET_OTHER, None
    return ASSET_OTHER, None


def classify_code(code: str):
    mkt, c = tdx.normalize_code(code)
    return classify(mkt, c)


# ---------------------------------------------------------------------------
# base.dbf（上市日期 / 行业）
# ---------------------------------------------------------------------------

def _read_dbf(path: str, want=("GPDM", "SSDATE", "HY")):
    """极简 dBase III 读取器（只取需要的字段）。"""
    raw = open(path, "rb").read()
    nrec = struct.unpack("<I", raw[4:8])[0]
    hsz = struct.unpack("<H", raw[8:10])[0]
    rsz = struct.unpack("<H", raw[10:12])[0]
    fields, off = [], 32
    while raw[off] != 0x0D:
        nm = raw[off:off + 11].split(b"\x00")[0].decode("gbk", "ignore")
        fields.append((nm, raw[off + 16]))
        off += 32
    out = {}
    start = hsz
    for r in range(nrec):
        rec = raw[start + r * rsz: start + (r + 1) * rsz]
        if not rec or rec[0:1] in (b"*", b"\x00"):
            continue
        pos, vals = 1, {}
        for nm, ln in fields:
            if nm in want:
                vals[nm] = rec[pos:pos + ln].decode("gbk", "ignore").strip()
            pos += ln
        code = vals.get("GPDM", "")
        if code:
            out[code] = vals
    return out


def _load_names():
    """当前股票名称（含 ST 前缀）。来源 infoharbor_ex.code: code|name|related"""
    p = os.path.join(HQ_CACHE, "infoharbor_ex.code")
    names = {}
    if os.path.isfile(p):
        for line in open(p, encoding="gbk", errors="ignore"):
            parts = line.rstrip("\n").split("|")
            if len(parts) >= 2 and parts[0].strip().isdigit():
                names[parts[0].strip().zfill(6)] = parts[1].strip()
    return names


def _load_industry():
    """通达信行业代码。来源 tdxhy.cfg: market|code|Txxxx|||Xxxxxx"""
    p = os.path.join(HQ_CACHE, "tdxhy.cfg")
    out = {}
    if os.path.isfile(p):
        for line in open(p, encoding="gbk", errors="ignore"):
            parts = line.rstrip("\n").split("|")
            if len(parts) >= 3 and parts[1].strip().isdigit():
                out[parts[1].strip().zfill(6)] = parts[2].strip()
    return out


# ---------------------------------------------------------------------------
class Universe:
    """股票池与可交易性判定。

    有**两条互相独立**的轴，必须分开设置（见 docs/02_选股条件登记表.md 未决 D）：

    轴 1 — ST 口径 `st_mode`
        'off'          不过滤 ST
        'current'      剔除「当前名称含 ST」的标的
        'conservative' 剔除「当前名称含 ST」的标的（= 曾经 ST 的保守代理，用户 2026-09-20 选定）

    轴 2 — 退市标的 `include_delisted`
        True （默认）历史池中，只要该标的**在 date 当天还活着**就允许进入
                     → 规避幸存者偏差，这是回测的正确做法
        False        只允许「今天仍在市」（出现在当前名称表中）的标的
                     → 引入幸存者偏差，收益会被高估；仅适合「今天选股」的场景

    注意：`st_mode='conservative'` 用的是**当前**名称快照，本地没有历史名称表，
    因此它并不能真正消除「在 T 日就知道未来会 ST」的未来信息。详见 bias_notes()。
    """

    def __init__(self, hub, st_mode: str = "conservative",
                 min_list_days: int | None = 250,
                 include_delisted: bool = True):
        if st_mode not in ("off", "current", "conservative"):
            raise ValueError("st_mode 只能是 'off' / 'current' / 'conservative'")
        self.hub = hub
        self.st_mode = st_mode
        self.min_list_days = min_list_days
        self.include_delisted = include_delisted
        self.names = _load_names()
        self._base = None
        self._industry = None
        self._first_bar = {}

    # ---------------- 元数据 ----------------
    @property
    def base(self):
        if self._base is None:
            p = os.path.join(HQ_CACHE, "base.dbf")
            self._base = _read_dbf(p) if os.path.isfile(p) else {}
        return self._base

    @property
    def industry(self):
        if self._industry is None:
            self._industry = _load_industry()
        return self._industry

    def name(self, code: str) -> str:
        """名称。注意：通达信名称表无市场列，`sh000xxx`（上证指数）会与
        `sz000xxx`（深市股票）代码撞号。故**仅对判定为股票的标的**返回名称，
        避免把指数的名字取成深市股票的名字。"""
        mkt, c = tdx.normalize_code(code)
        if classify(mkt, c)[0] != ASSET_STOCK:
            return tdx.full_code(code)
        return self.names.get(c, tdx.full_code(code))

    def code6(self, code: str) -> str:
        return tdx.normalize_code(code)[1]

    def is_st(self, code: str) -> bool:
        """当前名称是否含 ST。注意：这是**当前**状态，不是历史状态。"""
        mkt, c = tdx.normalize_code(code)
        if classify(mkt, c)[0] != ASSET_STOCK:
            return False
        return "ST" in self.names.get(c, "").upper()

    def asset(self, code: str) -> str:
        return classify_code(code)[0]

    def board(self, code: str) -> str:
        return classify_code(code)[1]

    def list_date(self, code: str) -> int:
        """上市日期 YYYYMMDD。优先 base.dbf 的 SSDATE；退市股回退为首根 bar 日期。"""
        c = self.code6(code)
        v = self.base.get(c, {}).get("SSDATE", "")
        if v and v.isdigit() and len(v) == 8:
            return int(v)
        return self.first_bar_date(code)

    def first_bar_date(self, code: str) -> int:
        key = tdx.full_code(code)
        if key not in self._first_bar:
            rec = self.hub.daily(key)
            self._first_bar[key] = int(rec["date"][0]) if rec.size else 0
        return self._first_bar[key]

    def listed_days(self, code: str, date: int) -> int:
        """截至 date 已上市的交易日数（用本地日线近似）。"""
        rec = self.hub.daily(code)
        if rec.size == 0:
            return 0
        hi = int(np.searchsorted(rec["date"], date, side="right"))
        return hi

    def status(self, code: str) -> dict:
        asset, board = classify_code(code)
        return {
            "code": tdx.full_code(code),
            "name": self.name(code),
            "asset": asset,
            "board": board,
            "is_st": self.is_st(code),
            "list_date": self.list_date(code),
            "industry": self.industry.get(self.code6(code), ""),
        }

    # ---------------- 过滤 ----------------
    def eligible(self, code: str, date: int, *,
                 exclude_st: bool = True,
                 exclude_new: bool = True,
                 include_delisted: bool | None = None,
                 boards: tuple | None = None) -> bool:
        """判断 code 在 date 当天是否进入股票池。

        boards: 允许的板块元组，None = 全部（主板/创业板/科创板/北交所，不含 B 股）
        """
        asset, board = classify_code(code)
        if asset != ASSET_STOCK:
            return False
        if board == BOARD_B:                      # B 股默认排除
            return False
        if boards is not None and board not in boards:
            return False

        keep_del = self.include_delisted if include_delisted is None else include_delisted
        c6 = tdx.normalize_code(code)[1]
        if not keep_del and c6 not in self.names:
            return False                          # 今天已不在市 → 剔除（引入幸存者偏差）

        if exclude_st and self.st_mode in ("current", "conservative") and self.is_st(code):
            return False

        if exclude_new:
            if self.min_list_days is None:
                raise ValueError(
                    "exclude_new=True 但未给定 min_list_days。\n"
                    "「次新」的天数阈值属于量化条件，必须由用户给定并登记在 "
                    "docs/02_选股条件登记表.md（Q13），不得由助手臆造。"
                )
            if self.listed_days(code, date) < self.min_list_days:
                return False
        # 当日必须有可交易 bar（自动排除当天停牌 / 当天尚未上市 / 当天已退市）
        if self.hub.bar(code, date) is None:
            return False
        return True

    def snapshot(self, cal_all: list, date: int, **kw) -> list:
        """返回 date 当天的合格股票池。cal_all 为待考察的全部标的。"""
        return [c for c in cal_all if self.eligible(c, date, **kw)]

    def bias_notes(self) -> list:
        """当前配置下已知的偏差，供回测报告如实披露。"""
        notes = []
        if self.st_mode in ("current", "conservative"):
            notes.append(
                "ST 过滤使用**当前**名称快照（infoharbor_ex.code，本地无历史名称表）。"
                "这**不能**消除未来信息：一只 2023 年才 ST 的股票，在 2020 年的池子里"
                "也会被剔除（结果是收益被高估）。'conservative' 与 'current' 在本地的"
                "可执行结果相同，只是语义上把「当前 ST」当作「曾经 ST」的保守代理。"
            )
        if not self.include_delisted:
            notes.append(
                "include_delisted=False：历史池只含「今天仍在市」的标的 → "
                "**引入幸存者偏差**，回测收益会被系统性高估。仅适合「今天选股」场景。"
            )
        else:
            notes.append(
                "include_delisted=True：历史池包含「在 date 当天仍活着」的退市股 → 规避幸存者偏差。"
                "这些标的的名称不可核实（不在当前名称表），报告中会单独计数。"
            )
        notes.append(
            f"次新阈值 min_list_days={self.min_list_days}"
            + ("（未启用）" if self.min_list_days is None else " 个交易日")
        )
        notes.append(
            "上市日期优先取 base.dbf 当前快照的 SSDATE；退市股回退为本地日线首根 bar 日期（近似）。"
        )
        notes.append(
            "板块/行业分类（tdxhy.cfg）同样只有当前快照，不可用于历史板块轮动研究。"
        )
        return notes

    def unverified_codes(self, codes) -> list:
        """不在当前名称表中的标的（= 已退市 / 身份不可核实）。"""
        return [c for c in codes if tdx.normalize_code(c)[1] not in self.names]
