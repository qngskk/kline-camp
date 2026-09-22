# -*- coding: utf-8 -*-
"""把通达信本地日线构建成 GitHub Pages 可直接托管的静态训练数据。

产出（默认 docs/data/）：
    {code}.bin      单只股票的前复权日线（紧凑二进制，见下）
    index.json      股票清单 + 可随机日期边界
    manifest.json   本次构建的参数与统计（自检用）

数据口径
--------
* 价格：**前复权**（gbbq 除权除息因子，最新价不变口径），直接复用 src/adj.py。
* 区间：切片 [WINDOW_FROM, WINDOW_TO]。窗口前多取 3 个月日线，
        以便「随机日期」最早一批也有完整的前 3 个月 K 线。
* 只保留 sh/sz 的 A 股，剔除 B 股、当前名称含 ST 的标的、窗口内 bar 数不足的标的。

二进制格式 KLC1（全部小端）
---------------------------
    头 32 字节：
        0  magic     4s   b"KLC1"
        4  n         u32  bar 数
        8  date0     u32  首根 bar 日期 YYYYMMDD
        12 pmin      f32  价格量化下界（元）
        16 pstep     f32  价格量化步长（元）
        20 vmin      f32  成交量量化下界（对数空间）
        24 vstep     f32  成交量量化步长（对数空间）
        28 reserved  u32  0
    随后 6 个定长数组，各 n 个元素：
        gap   u16  与上一根 bar 的自然日间隔（gap[0] = 0）
        open  u16  high u16 low u16 close u16   量化价格，price = pmin + q * pstep
        vol   u16  量化成交量，vol = exp(vmin + q * vstep)  单位：股
    合计 32 + 12n 字节。

    量化误差：价格 <= pstep/2（实测 < 0.5 分），成交量相对误差 <= vstep（实测 < 0.05%）。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import time
from collections import Counter

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from src import adj, tdx, universe  # noqa: E402

# --- 构建参数 -------------------------------------------------------------
WINDOW_FROM = 20240902          # 数据切片起点（给 2024-12 的随机日期留出 3 个月前置 K 线）
WINDOW_TO = 20260918            # 数据切片终点（本地日线最新）
RANDOM_FROM = 20241202          # 允许被抽中的「随机日期」下界
RANDOM_TO = 20260901            # 允许被抽中的「随机日期」上界
MIN_BARS = 160                  # 窗口内 bar 数下限（60 前置 + 1 + 90 窗口 + 余量）
PRE_BARS = 60                   # 前置 3 个月 ≈ 60 个交易日
HEADER = struct.Struct("<4sIIffffI")

BOARDS = [universe.BOARD_MAIN, universe.BOARD_GEM, universe.BOARD_STAR]
BOARD_IDX = {b: i for i, b in enumerate(BOARDS)}


def clean_name(s: str) -> str:
    return " ".join(str(s).replace("\u3000", " ").split())


def normalize_name(n: str) -> str:
    """把全角 Ａ 之类还原成半角，避免页面上显示怪异。"""
    out = []
    for ch in n:
        o = ord(ch)
        if 0xFF01 <= o <= 0xFF5E:
            out.append(chr(o - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)


def load_names() -> dict:
    p = os.path.join(universe.HQ_CACHE, "infoharbor_ex.code")
    names = {}
    if os.path.isfile(p):
        with open(p, encoding="gbk", errors="ignore") as f:
            for line in f:
                parts = line.rstrip("\n").split("|")
                if len(parts) >= 2 and parts[0].strip().isdigit():
                    names[parts[0].strip().zfill(6)] = normalize_name(clean_name(parts[1]))
    return names


def pack_stock(dates: np.ndarray, o, h, l, c, vol) -> bytes:
    """把一只股票的前复权日线打包成 KLC1。"""
    n = int(dates.size)
    d0 = int(dates[0])

    lo = float(min(o.min(), h.min(), l.min(), c.min()))
    hi = float(max(o.max(), h.max(), l.max(), c.max()))
    pmin = max(lo - 1e-4, 0.0)
    pstep = max((hi - pmin) / 65535.0, 1e-6)

    def q_price(x):
        q = np.rint((x - pmin) / pstep)
        return np.clip(q, 0, 65535).astype("<u2")

    v = np.maximum(vol.astype("f8"), 1.0)
    lv = np.log(v)
    vmin = float(lv.min())
    vstep = max((float(lv.max()) - vmin) / 65535.0, 1e-12)

    def q_vol(x):
        q = np.rint((np.log(np.maximum(x.astype("f8"), 1.0)) - vmin) / vstep)
        return np.clip(q, 0, 65535).astype("<u2")

    gaps = np.diff(dates.astype("i8"), prepend=dates[0].astype("i8"))
    assert gaps.max() < 65536, "相邻 bar 间隔超出 u16"

    buf = io.BytesIO()
    buf.write(HEADER.pack(b"KLC1", n, d0, pmin, pstep, vmin, vstep, 0))
    buf.write(gaps.astype("<u2").tobytes())
    for arr in (q_price(o), q_price(h), q_price(l), q_price(c), q_vol(vol)):
        buf.write(arr.tobytes())
    return buf.getvalue()


def decode_pack(raw: bytes) -> dict:
    """独立解码器 —— 仅用于构建后自检，不参与页面。"""
    magic, n, d0, pmin, pstep, vmin, vstep, _ = HEADER.unpack_from(raw, 0)
    assert magic == b"KLC1", magic
    off = HEADER.size
    a = np.frombuffer(raw, dtype="<u2", count=n * 6, offset=off).reshape(6, n)
    gaps, o, h, l, c, v = a
    dates = int(d0) + np.cumsum(gaps.astype("i8"))
    px = lambda q: pmin + q.astype("f8") * pstep
    return {
        "dates": dates, "open": px(o), "high": px(h), "low": px(l), "close": px(c),
        "vol": np.exp(vmin + v.astype("f8") * vstep),
    }


def build_bench(out_dir: str, index_code: str = "sh000300"):
    """导出基准指数（默认沪深300）在窗口内的日收盘，供结算面板做「同期大盘」对照。

    指数不需要复权，直接取原始收盘。
    """
    rec = tdx.read_day(index_code, start=WINDOW_FROM, end=WINDOW_TO)
    if rec.size == 0:
        print(f"      [warn] 找不到基准指数 {index_code}，跳过")
        return None
    obj = {
        "code": index_code,
        "name": "沪深300",
        "from": int(rec["date"][0]),
        "to": int(rec["date"][-1]),
        "dates": [int(x) for x in rec["date"]],
        "close": [round(float(x), 2) for x in rec["close"]],
    }
    p = os.path.join(out_dir, "bench.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"      基准指数 {index_code} {obj['from']}~{obj['to']} {len(obj['dates'])} 根 -> bench.json ({os.path.getsize(p)} B)")
    return obj


FILTER_LOOKBACK = 60
FILTER_PRIOR_N = 20         # 「前期高点」= 近 20 根（不含当日）的最高价，≈一个月


def _ema(x: np.ndarray, n: int) -> np.ndarray:
    """与前端 sim.js 的 ema() 完全同口径（首值做种子）"""
    a = 2.0 / (n + 1)
    out = np.empty(x.size, dtype="f8")
    prev = float(x[0])
    for i in range(x.size):
        prev = float(x[0]) if i == 0 else a * x[i] + (1 - a) * prev
        out[i] = prev
    return out


def _r2(x):
    """与前端 decode.js 完全一致的四舍五入到分（JS Math.round 是「半数进位」，
    numpy 默认是「半数取偶」，必须自己实现，否则边界值会不一致）"""
    return np.floor(x * 100.0 + 0.5) / 100.0


def filter_masks(code: str, axis: dict, out_dir: str = None):
    """算出一只标的在「可抽日期轴」上每天的筛选位掩码。

    ⚠️ 必须用**前端看到的那份数据**（docs/data/*.bin 解码并取整到分），不能用原始 .day：
       MACD 的 EMA 以第一根为种子，是路径依赖的；用全历史算出来的金叉位置和前端会错开。
    位定义必须与 docs/js/sim.js 的 FILTER_DEFS 一致：
      1  上涨趋势中回踩2天（T-3高于5天前 + 相对T-3最高价低3~10% + T-1、T 都低于 T-2 收盘）
      2  最近连续 2 天收盘上涨
      4  当日收阳，且开盘价高于前 2 日最高价
      8  当日收阳，且开盘价高于「前期高点」
      16 MACD 零下金叉（DIF 上穿 DEA 且 DIF < 0）
    """
    nd = len(axis["dates"])
    m = np.zeros(nd, dtype=np.uint8)
    if out_dir:
        p = os.path.join(out_dir, code[2:] + ".bin")
        if not os.path.isfile(p):
            return m
        d = decode_pack(open(p, "rb").read())
        cl = _r2(d["close"]); op = _r2(d["open"]); hi = _r2(d["high"])
        dates = d["dates"].astype("i8")
    else:
        rec = tdx.read_day(code)
        if rec.size == 0:
            return m
        cl = rec["close"].astype("f8"); op = rec["open"].astype("f8"); hi = rec["high"].astype("f8")
        dates = rec["date"].astype("i8")
    n = cl.size
    if n < 250:
        return m
    dif = _ema(cl, 12) - _ema(cl, 26)
    dea = _ema(dif, 9)

    # prior_hi[i] = max(hi[max(0,i-N):i])：近 N 根、**不含当日**的最高价
    # 用区间最高价而不是分形拐点 —— 分形高点必须等右侧 k 根走完才能确认，
    # 决策当天必然滞后（周大生 SZ002867 2026-01-15 真正的前高是 2 天前的 12.00，
    # 分形法只能看到 3 周前的 11.68，于是误判为"突破"）。
    N = FILTER_PRIOR_N
    prior_hi = np.full(n, np.nan)
    if n > 1:
        cummax = np.maximum.accumulate(hi)
        for i in range(1, min(N, n)):
            prior_hi[i] = cummax[i - 1]
        if n > N:
            W = sliding_window_view(hi, N).max(axis=1)     # W[j] = max(hi[j:j+N])
            prior_hi[N:] = W[:n - N]

    lo, hi_d = axis["lo"], axis["hi"]
    for k in range(nd):
        d = axis["dates"][k]
        i = int(np.searchsorted(dates, d))
        if i >= n or int(dates[i]) != d or i < 70:
            continue
        if d < lo or d > hi_d:
            continue
        ph = float(prior_hi[i]) if np.isfinite(prior_hi[i]) else np.nan
        v = 0
        # ① 上涨趋势中回踩 2 天（用户 2026-09-22 指定）：
        #    T-3 高于 5 天前 + 收盘相对 T-3 最高价低 3%~10% + T-1、T 都收在 T-2 下方
        t3 = i - 3
        if (t3 - 5 >= 0 and cl[t3] > cl[t3 - 5] and hi[t3] > 0
                and -0.10 <= cl[i] / hi[t3] - 1 <= -0.03
                and cl[i - 1] < cl[i - 2] and cl[i] < cl[i - 2]):
            v |= 1
        if cl[i] > cl[i - 1] > cl[i - 2]:
            v |= 2
        bullish = cl[i] > op[i]
        if bullish and op[i] > max(hi[i - 1], hi[i - 2]):
            v |= 4
        if bullish and np.isfinite(ph) and op[i] > ph:
            v |= 8
        if dif[i] > dea[i] and dif[i - 1] <= dea[i - 1] and dif[i] < 0:
            v |= 16
        m[k] = v
    return m


def build_filter(stocks, out_dir: str):
    """生成 docs/data/filter.bin —— 「换股筛选」的倒排索引。

    给四个稀有条件建倒排表（实测通过率）：
        ① 上涨趋势中回踩2天  8.8%
        ③ 阳线实体超前2日高   2.3%
        ④ 阳线实体破前高     0.6%
        ⑤ MACD 零下金叉     2.4%
    只有 ②(23%) 太常见，建表反而占空间，前端拿到候选后实时判定即可。
    这样任意组合（含"全选"）都能一次锁定候选，不必盲抽。

    格式（全部小端）：
        'KLF3' | u32 nd | u32 n1 | u32 n4 | u32 n8 | u32 n16
              | u32 dates[nd] | u32 off1[nd+1] | u32 off4[nd+1] | u32 off8[nd+1] | u32 off16[nd+1]
              | u16 idx1[n1]  | u16 idx4[n4]  | u16 idx8[n8]  | u16 idx16[n16]
    """
    cal = tdx.trading_calendar(start=RANDOM_FROM, end=RANDOM_TO)
    dates = [int(d) for d in cal]
    axis = {"dates": dates, "lo": RANDOM_FROM, "hi": RANDOM_TO}
    nd = len(dates)
    BITS = (1, 4, 8, 16)
    lists = {b: [[] for _ in range(nd)] for b in BITS}
    t0 = time.time()
    for r, code in enumerate(stocks):
        m = filter_masks(code, axis, out_dir)
        for b in BITS:
            for k in np.nonzero(m & b)[0]:
                lists[b][int(k)].append(r)
        if (r + 1) % 1500 == 0:
            print(f"      filter {r+1}/{len(stocks)} {time.time()-t0:.0f}s")

    flat, offs = {}, {}
    for b in BITS:
        arr, off = [], [0]
        for k in range(nd):
            arr.extend(lists[b][k]); off.append(len(arr))
        flat[b], offs[b] = arr, off

    buf = io.BytesIO()
    buf.write(b"KLF3")
    buf.write(np.array([nd] + [len(flat[b]) for b in BITS], "<u4").tobytes())
    buf.write(np.array(dates, "<u4").tobytes())
    for b in BITS:
        buf.write(np.array(offs[b], "<u4").tobytes())
    for b in BITS:
        buf.write(np.array(flat[b], "<u2").tobytes())
    blob = buf.getvalue()
    with open(os.path.join(out_dir, "filter.bin"), "wb") as f:
        f.write(blob)
    print(f"      筛选索引 {nd} 天 / " + " / ".join(f"C{b}:{len(flat[b]):,}" for b in BITS) +
          f" -> filter.bin ({len(blob)/1e6:.2f} MB, {time.time()-t0:.0f}s)")
    return {"dates": nd, **{f"c{b}": len(flat[b]) for b in BITS}, "bytes": len(blob)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "data"))
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只（调试用）")
    ap.add_argument("--no-cache", action="store_true", help="不使用复权因子 npz 缓存")
    ap.add_argument("--bench-only", action="store_true", help="只重建基准指数 bench.json")
    ap.add_argument("--filter-only", action="store_true", help="只重建筛选索引 filter.bin")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    if args.bench_only:
        build_bench(args.out)
        return
    if args.filter_only:
        idx_p = os.path.join(args.out, "index.json")
        with open(idx_p, encoding="utf-8") as f:
            stocks = [s[0] for s in json.load(f)["stocks"]]
        build_filter(stocks, args.out)
        return
    names = load_names()
    print(f"[1/3] 名称表 {len(names)} 条")

    gbbq = adj.Gbbq()
    print(f"[2/3] gbbq 除权除息 {gbbq.n_events:,} 条 / {gbbq.n_codes:,} 标的")

    codes = []
    for mkt in ("sh", "sz"):
        for full in tdx.list_codes(market=mkt, kind="lday"):
            m, c6 = tdx.normalize_code(full)
            asset, board = universe.classify(m, c6)
            if asset != universe.ASSET_STOCK or board == universe.BOARD_B:
                continue
            if board not in BOARD_IDX:
                continue          # 排除北交所
            nm = names.get(c6, "")
            if "ST" in nm.upper():           # 当前名称快照口径（已知偏差，见 README）
                continue
            codes.append((full, c6, board, nm))
    print(f"      A 股候选 {len(codes)} 只（已剔除北交所 / B 股 / 当前 ST）")

    stocks = []
    stats = Counter()
    skipped = Counter()
    for i, (full, c6, board, nm) in enumerate(codes, 1):
        if args.limit and i > args.limit:
            break
        raw = tdx.read_day(full)
        if raw.size == 0:
            skipped["无数据"] += 1
            continue
        d_all = raw["date"].astype("i8")
        prior = int((d_all < WINDOW_FROM).sum())

        fac_dates, factors = adj.daily_factors(full, gbbq, use_cache=not args.no_cache)
        fmap = {int(d): float(f) for d, f in zip(fac_dates, factors)} if fac_dates.size else {}

        lo = int(np.searchsorted(d_all, WINDOW_FROM, side="left"))
        hi = int(np.searchsorted(d_all, WINDOW_TO, side="right"))
        rec = raw[lo:hi]
        if rec.size < MIN_BARS:
            skipped["窗口内bar不足"] += 1
            continue

        fac = np.array([fmap.get(int(d), 1.0) for d in rec["date"]], dtype="f8")
        prices = {f: rec[f].astype("f8") * fac for f in ("open", "high", "low", "close")}
        blob = pack_stock(rec["date"].astype("i8"), prices["open"], prices["high"],
                          prices["low"], prices["close"], rec["vol"].astype("f8"))
        with open(os.path.join(args.out, f"{c6}.bin"), "wb") as f:
            f.write(blob)

        # 自检：独立解码后与源数据对比
        chk = decode_pack(blob)
        err = float(np.max(np.abs(chk["close"] - prices["close"])))
        verr = float(np.max(np.abs(chk["vol"] / np.maximum(rec["vol"], 1) - 1.0)))
        assert err < 0.05, f"{full} 收盘价重建误差 {err}"
        assert verr < 1e-3, f"{full} 成交量重建误差 {verr}"
        if err > stats["max_price_err"]:
            stats["max_price_err"] = err
            stats["worst_price"] = full
        stats["max_vol_err"] = max(stats["max_vol_err"], verr)
        stats["bars"] += rec.size

        # 允许被抽中的「随机日期」在窗口内的下标区间
        rd = rec["date"].astype("i8")
        i_from = int(np.searchsorted(rd, RANDOM_FROM, side="left"))
        i_to = int(np.searchsorted(rd, RANDOM_TO, side="right")) - 1

        stocks.append([full, nm or c6, BOARD_IDX[board], int(rec.size), prior,
                       i_from, max(i_to, -1)])
        if i % 500 == 0:
            print(f"      {i}/{len(codes)}  {time.time()-t0:.0f}s")

    stocks.sort(key=lambda s: s[0])
    index = {
        "v": 1,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "通达信 vipdoc 本地日线（前复权）",
        "window": [WINDOW_FROM, WINDOW_TO],
        "random": [RANDOM_FROM, RANDOM_TO],
        "preBars": PRE_BARS,
        "boards": BOARDS,
        "stocks": stocks,
    }
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    build_bench(args.out)
    filter_stat = build_filter([s[0] for s in stocks], args.out)

    total_bytes = sum(os.path.getsize(os.path.join(args.out, s[0][2:] + ".bin")) for s in stocks)
    manifest = {
        "generated": index["generated"],
        "window": index["window"], "random": index["random"],
        "stocks": len(stocks), "bars": int(stats["bars"]),
        "bin_bytes": total_bytes,
        "max_price_err": stats["max_price_err"], "worst_price": stats["worst_price"],
        "max_vol_err": stats["max_vol_err"],
        "skipped": dict(skipped),
        "index_bytes": os.path.getsize(os.path.join(args.out, "index.json")),
        "filter": filter_stat,
        "elapsed_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"[3/3] 完成：{len(stocks)} 只 / {stats['bars']:,} 根 bar / "
          f"{total_bytes/1e6:.1f} MB，耗时 {time.time()-t0:.0f}s")
    print("      价格重建最大误差 %.5f 元，成交量重建最大相对误差 %.2e" %
          (stats["max_price_err"], stats["max_vol_err"]))
    print("      跳过：", dict(skipped))


if __name__ == "__main__":
    main()
