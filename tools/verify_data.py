# -*- coding: utf-8 -*-
"""数据链路审计：独立复核「原始 .day → 前复权 → KLC1 量化 → 前端解码」这条链上的价格。

刻意**不复用** src/adj.py / src/tdx.py 的实现：
  * .day 用本文件里的解析器自己 unpack；
  * 复权因子按定义自己算（不调用 adj.daily_factors）；
  * 再与 docs/data/*.bin 解码出来的价格逐根比对。

审计项
------
1. 开盘价 / 最高价 / 最低价 / 收盘价：量化后的重建误差分布（绝对值 + 折算成收益率误差）
2. 日期序列：解码日期 == 原始 .day 日期（全等）
3. 前复权有效性：最后一根 bar 的复权价 == 原始价（无后续除权事件）
4. 前复权有效性：除权日前后「复权后跳空」应远小于「原始跳空」
5. 成交量单位与量级：amount / vol 应落在当日的 [low, high] 区间内（证明 vol 单位是股、amount 单位是元）
6. 成交额近似：用 close×vol 代替真实成交额的相对误差
7. OHLC 关系：high >= max(o,c)、low <= min(o,c)、价格恒正

用法： python tools/verify_data.py [样本数量=300]
"""
from __future__ import annotations

import json
import os
import struct
import sys
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from tools.build_data import decode_pack  # noqa: E402

TDX_ROOT = os.environ.get("TDX_ROOT", "/mnt/g/new_tdx/vipdoc")
GBBQ = os.environ.get("TDX_GBBQ", "/mnt/g/new_tdx/T0002/hq_cache/gbbq")
DATA = os.path.join(ROOT, "docs", "data")

DAY = np.dtype([("date", "<u4"), ("open", "<u4"), ("high", "<u4"), ("low", "<u4"),
                ("close", "<u4"), ("amount", "<f4"), ("vol", "<u4"), ("rsv", "<u4")])


# ---------------------------------------------------------------- 独立解析
def read_day_raw(code: str) -> np.ndarray:
    p = os.path.join(TDX_ROOT, code[:2], "lday", code + ".day")
    if not os.path.isfile(p):
        return np.zeros(0, dtype=DAY)
    return np.fromfile(p, dtype=DAY)


def load_events():
    """{(market, code): [(ex_date, 每10股派现, 每10股送股, 每10股配股, 配股价)]}"""
    from pytdx.reader.gbbq_reader import GbbqReader
    df = GbbqReader().get_df(GBBQ)
    ev = defaultdict(list)
    for r in df[df["category"] == 1].itertuples():
        ev[(int(r.market), str(r.code).zfill(6))].append((
            int(r.datetime), float(r.hongli_panqianliutong), float(r.songgu_qianzongguben),
            float(r.peigu_houzongguben), float(r.peigujia_qianzongguben)))
    for k in ev:
        ev[k].sort()
    return ev


def factor_series(dates: np.ndarray, close_raw: np.ndarray, events) -> np.ndarray:
    """按定义独立计算每根 bar 的前复权因子：factors[t] = Π_{除权日 > date[t]} f。

    f = (除权日前收盘 − 每股派现 + 配股价 × 每股配股) / (除权日前收盘 × (1 + 每股送股 + 每股配股))

    注意 j >= dates.size 的含义：除权日在**最后一根 bar 之后**（gbbq 里包含已公告但尚未实施的
    除权除息日）。此时数据里根本不存在那个缺口，若还去乘因子会把「最新价」也一起缩放，
    破坏「最新价不变」口径，所以必须跳过。
    """
    fac = np.ones(dates.size, dtype="f8")
    for (dt, hl10, sg10, pg10, pp) in events:
        # 除权日之前（不含除权日当天）的所有 bar 都要乘上该因子
        j = int(np.searchsorted(dates, dt, side="left"))
        if j <= 0 or j >= dates.size:
            continue
        pc = close_raw[j - 1]
        if pc <= 0:
            continue
        div, sg, pg = hl10 / 10.0, sg10 / 10.0, pg10 / 10.0
        f = (pc - div + pp * pg) / (pc * (1.0 + sg + pg))
        if not (0.01 < f < 2.0):
            continue
        fac[:j] *= f
    return fac


# ---------------------------------------------------------------- 主流程
def main(n_sample=300):
    idx = json.load(open(os.path.join(DATA, "index.json"), encoding="utf-8"))
    win = idx["window"]
    stocks = idx["stocks"]
    events = load_events()
    rng = np.random.default_rng(20240921)
    pick = rng.choice(len(stocks), size=min(n_sample, len(stocks)), replace=False)

    err = []                 # |量化价 − 真实复权价|（元）
    ret_err = []             # 折算成收益率误差
    vol_err = []             # 成交量相对误差
    amt_err = []             # 三种「成交额估算」与真实成交额的相对误差
    est_close_all, est_typ_all, est_ohlc_all = [], [], []
    unit_ratio = []          # amount/vol 落在 [low,high] 的比例
    ex_gap_raw, ex_gap_adj, ex_true_ret = [], [], []
    last_bars = 0
    last_exact = 0
    ohlc_bad = 0
    date_bad = 0
    bars_total = 0
    worst = []

    for si in pick:
        code, name = stocks[si][0], stocks[si][1]
        raw = read_day_raw(code)
        if raw.size == 0:
            continue
        # 与构建脚本口径对齐：构建时本地数据最新只到 WINDOW_TO，
        # 之后（本地数据又更新了几天）才出现的除权日不应反过来影响已发布的数据。
        # 这里把原始序列截到 WINDOW_TO，除权日落在其后的会被 factor_series 自动跳过。
        _k = int(np.searchsorted(raw["date"].astype("i8"), win[1], side="right"))
        raw = raw[:_k]
        # 注意：.day 里的价格是「分」，派现/配股价是「元」，必须统一成元再套公式
        fac = factor_series(raw["date"].astype("i8"), raw["close"].astype("f8") / 100.0,
                            events.get((1 if code[:2] == "sh" else 0, code[2:]), []))
        adj_o = raw["open"] / 100.0 * fac
        adj_h = raw["high"] / 100.0 * fac
        adj_l = raw["low"] / 100.0 * fac
        adj_c = raw["close"] / 100.0 * fac

        blob = open(os.path.join(DATA, code[2:] + ".bin"), "rb").read()
        d = decode_pack(blob)
        # 前端 decode.js 会把价格取整到「分」（A 股报价粒度），这里按同样口径比对
        for f in ("open", "high", "low", "close"):
            d[f] = np.round(d[f], 2)
        n = d["dates"].size

        # 只保留落在发布窗口内的那段做比对
        m = (raw["date"].astype("i8") >= win[0]) & (raw["date"].astype("i8") <= win[1])
        if int(m.sum()) != n:
            raise SystemExit(f"{code}: bin 内 {n} 根，原始窗口内 {int(m.sum())} 根，不一致")
        if not np.array_equal(d["dates"], raw["date"].astype("i8")[m]):
            date_bad += 1
        bars_total += n

        for f, real in (("open", adj_o), ("high", adj_h), ("low", adj_l), ("close", adj_c)):
            e = np.abs(d[f] - real[m])
            err.append(e.max())
            r = real[m]
            ret_err.append(float(np.max(e / np.maximum(r, 1e-9))))
            if f == "close":
                k = int(np.argmax(e))
                if not worst or e[k] > worst[0][0]:
                    worst = [(float(e[k]), code, name, int(d["dates"][k]),
                              float(real[m][k]), float(d["close"][k]))]

        vol_err.append(float(np.max(np.abs(d["vol"] / np.maximum(raw["vol"][m], 1) - 1.0))))

        # 量纲检查：amount / vol 应该就是当天的**原始**成交均价，必须落在原始 [low, high]
        # （不能用复权价比，否则除权日之前的 bar 会因为因子缩放而误判）
        v = raw["vol"][m].astype("f8")
        a = raw["amount"][m].astype("f8")
        raw_l = raw["low"][m] / 100.0
        raw_h = raw["high"][m] / 100.0
        ok = (v > 0) & (a > 0)
        if ok.sum():
            avg = a[ok] / v[ok]
            inside = (avg >= raw_l[ok] * 0.98) & (avg <= raw_h[ok] * 1.02)
            unit_ratio.append(float(inside.mean()))
            # 用**原始**价评估三种「成交额估算」的误差（页面只有 OHLCV，没有真实 amount）
            rc = raw["close"][m].astype("f8") / 100.0
            rh = raw["high"][m].astype("f8") / 100.0
            rl = raw["low"][m].astype("f8") / 100.0
            ro = raw["open"][m].astype("f8") / 100.0
            est_close = np.abs(rc[ok] * v[ok] / a[ok] - 1.0)
            est_typ = np.abs((rh[ok] + rl[ok] + rc[ok]) / 3.0 * v[ok] / a[ok] - 1.0)
            est_ohlc = np.abs((ro[ok] + rh[ok] + rl[ok] + rc[ok]) / 4.0 * v[ok] / a[ok] - 1.0)
            amt_err.append((float(est_close.max()), float(est_typ.max()), float(est_ohlc.max())))
            est_close_all.extend(est_close.tolist())
            est_typ_all.extend(est_typ.tolist())
            est_ohlc_all.extend(est_ohlc.tolist())
        elif v.size:
            unit_ratio.append(1.0)

        # 最后一根 bar：窗口右端之后没有除权事件时，复权价应等于原始价
        if int(raw["date"][-1]) <= win[1]:
            last_bars += 1
            if abs(float(fac[-1]) - 1.0) < 1e-12:
                last_exact += 1
                if abs(float(d["close"][-1]) - float(raw["close"][-1]) / 100.0) > 0.05:
                    raise SystemExit(f"{code}: 末根复权价与原始价不符")

        # 除权日前后：原始跳空 vs 复权跳空，以及「复权后的真实涨跌幅」
        for (dt, hl10, sg10, pg10, pp) in events.get((1 if code[:2] == "sh" else 0, code[2:]), []):
            j = int(np.searchsorted(raw["date"].astype("i8"), dt, side="left"))
            if j <= 0 or j >= raw.size:
                continue
            if not (win[0] <= int(raw["date"][j]) <= win[1]):
                continue
            rf = abs(raw["close"][j] / raw["close"][j - 1] - 1.0)
            af = abs(adj_c[j] / adj_c[j - 1] - 1.0)
            ex_gap_raw.append(float(rf - af))
            ex_gap_adj.append(float(af))
            # 非循环校验：复权后，除权日当天的涨跌幅应该回到正常的日内波动范围
            ex_true_ret.append(float(adj_c[j] / adj_c[j - 1] - 1.0))

        o = d["open"]; h = d["high"]; l = d["low"]; c = d["close"]
        ohlc_bad += int(np.sum((h < np.maximum(o, c) - 1e-6) | (l > np.minimum(o, c) + 1e-6)
                               | (l <= 0) | (d["vol"] <= 0)))

    err = np.array(err)
    ret_err = np.array(ret_err)
    vol_err = np.array(vol_err)
    amt_err = np.array(amt_err) if amt_err else np.zeros((1, 3))
    est_close_all = np.array(est_close_all) if est_close_all else np.array([0.0])
    est_typ_all = np.array(est_typ_all) if est_typ_all else np.array([0.0])
    est_ohlc_all = np.array(est_ohlc_all) if est_ohlc_all else np.array([0.0])
    unit_ratio = np.array(unit_ratio) if unit_ratio else np.array([1.0])

    print(f"审计样本：{len(pick)} 只股票 / {bars_total:,} 根 bar（窗口 {win[0]}~{win[1]}）\n")
    print("【1】价格重建误差（uint16 量化 + 前端取整到分 vs 原始前复权价）")
    print(f"    单只股票内的最大误差：中位 {np.median(err):.5f} 元，90 分位 {np.percentile(err,90):.5f} 元，最大 {err.max():.5f} 元")
    print(f"    折算成收益率误差：中位 {np.median(ret_err)*100:.5f}%，最大 {ret_err.max()*100:.4f}%")
    print(f"    （其中「取整到分」本身最多贡献 0.005 元，是为了让成交价 × 股数 = 成交额 可验算）")
    print(f"    最差样本：{worst[0][1]} {worst[0][2]} {worst[0][3]} 真实 {worst[0][4]:.4f} → 页面 {worst[0][5]:.4f}")

    print("\n【2】日期序列")
    print(f"    与原始 .day 日期完全一致：{'是' if date_bad == 0 else f'否（{date_bad} 只不一致）'}")

    print("\n【3】前复权：末根 bar 应等于原始价（此后无除权事件）")
    print(f"    末根因子 == 1.0（最新价不变）的样本：{last_exact}/{last_bars}")

    print("\n【4】前复权：除权日跳空是否被抹平（样本 %d 个除权日）" % len(ex_gap_adj))
    if ex_gap_adj:
        ex_gap_raw = np.array(ex_gap_raw)
        ex_gap_adj = np.array(ex_gap_adj)
        ex_true_ret = np.array(ex_true_ret)
        print(f"    复权后被抹掉的跳空：中位 {np.median(ex_gap_raw)*100:.3f} 个百分点，最大 {ex_gap_raw.max()*100:.3f}")
        print(f"    复权后残余日内波动：中位 {np.median(ex_gap_adj)*100:.3f}%，最大 {ex_gap_adj.max()*100:.3f}%")
        print(f"    ★非循环校验 除权日复权后真实涨跌幅：中位 {np.median(ex_true_ret)*100:+.3f}%，"
              f"绝对值的 99 分位 {np.percentile(np.abs(ex_true_ret),99)*100:.2f}%，最大 |{np.abs(ex_true_ret).max()*100:.2f}%|")
        over = int((np.abs(ex_true_ret) > 0.21).sum())
        print(f"      超出 ±21%（涨跌停上限）的除权日：{over} 个 —— 因子若算错，这里会立刻爆掉")

    print("\n【5】成交量单位（amount/vol 是否落在当日最低~最高价之间）")
    print(f"    合格比例 {unit_ratio.mean()*100:.3f}%（若 vol 被误当手，这里会接近 0）")

    print("\n【6】成交额：页面只有 OHLCV，没有真实 amount，看哪种估算最接近真实成交额")
    print(f"    收盘价×量          ：逐 bar 中位误差 {np.median(est_close_all)*100:6.3f}%，99 分位 {np.percentile(est_close_all,99)*100:6.3f}%")
    print(f"    (高+低+收)/3×量    ：逐 bar 中位误差 {np.median(est_typ_all)*100:6.3f}%，99 分位 {np.percentile(est_typ_all,99)*100:6.3f}%")
    print(f"    (开+高+低+收)/4×量 ：逐 bar 中位误差 {np.median(est_ohlc_all)*100:6.3f}%，99 分位 {np.percentile(est_ohlc_all,99)*100:6.3f}%")

    print("\n【7】K 线自身一致性")
    print(f"    违反 high>=max(o,c) / low<=min(o,c) / 价格为负 的 bar 数：{ohlc_bad}")

    bad = (ohlc_bad or date_bad or ret_err.max() > 0.01 or last_exact != last_bars)
    print("\n结论：价格链路" + ("发现问题" if bad else "未发现结构性错误") +
          f"；量化引入的收益率误差上限 {ret_err.max()*100:.4f}%（可忽略）")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 300))
