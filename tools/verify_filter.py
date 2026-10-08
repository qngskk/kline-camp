# -*- coding: utf-8 -*-
"""筛选索引一致性验证：filter.bin 的生成口径（Python）必须与前端判定（JS）逐位一致（8 个条件）。

之所以必须验证：MACD 的 EMA 以第一根为种子，是**路径依赖**的 ——
用全历史算 vs 用窗口内数据算，金叉位置会错开。这里随机抽若干「股票×日期」，
分别用两套实现算 5 个条件的掩码并逐位比对。

用法： python tools/verify_filter.py [样本数=400]
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from tools.build_data import (FILTER_MIN_IDX, FILTER_PRIOR_N, MA_EPS, RANDOM_FROM,
                              RANDOM_TO, _ema, _r2, decode_pack)  # noqa: E402
from src import tdx  # noqa: E402
import numpy as np  # noqa: E402


def mask_of(code: str, date: int) -> int:
    """与 build_filter 完全相同的实现（唯一区别：只算一天）"""
    d = decode_pack(open(os.path.join(ROOT, "docs", "data", code[2:] + ".bin"), "rb").read())
    cl = _r2(d["close"]); op = _r2(d["open"]); hi = _r2(d["high"]); lo = _r2(d["low"])
    dates = d["dates"].astype("i8")
    n = cl.size
    i = int(np.searchsorted(dates, date))
    if i >= n or int(dates[i]) != date or i < FILTER_MIN_IDX:
        return 0
    dif = _ema(cl, 12) - _ema(cl, 26); dea = _ema(dif, 9)
    ph = float(hi[max(0, i - FILTER_PRIOR_N):i].max())
    v = 0
    t3 = i - 3
    if (t3 - 5 >= 0 and cl[t3] > cl[t3 - 5] and hi[t3] > 0
            and -0.10 <= cl[i] / hi[t3] - 1 <= -0.03
            and cl[i - 1] < cl[i - 2] and cl[i] < cl[i - 2]):
        v |= 1
    if cl[i] > cl[i - 1] > cl[i - 2]:
        v |= 2
    bullish = cl[i] > op[i]
    if bullish and cl[i] > max(hi[i - 1], hi[i - 2]):
        v |= 4
    if bullish and cl[i] > ph:
        v |= 8
    if dif[i] > dea[i] and dif[i - 1] <= dea[i - 1] and dif[i] < 0:
        v |= 16
    body = abs(cl[i] - op[i])
    big = cl[i - 1] > 0 and body / cl[i - 1] >= 0.06
    hi20 = hi[i - 19:i + 1].max(); lo20 = lo[i - 19:i + 1].min()
    span = hi20 - lo20
    pos = (cl[i] - lo20) / span if span > 0 else 0.5
    if big and cl[i] > op[i] and pos <= 0.20:
        v |= 32
    if big and cl[i] < op[i] and pos >= 0.80:
        v |= 64
    if (cl[i - 4:i + 1].mean() - cl[i - 9:i + 1].mean() > MA_EPS
            and cl[i - 9:i + 1].mean() - cl[i - 19:i + 1].mean() > MA_EPS
            and cl[i - 19:i + 1].mean() - cl[i - 59:i + 1].mean() > MA_EPS
            and cl[i - 4:i + 1].mean() - cl[i - 5:i].mean() > MA_EPS
            and cl[i - 9:i + 1].mean() - cl[i - 10:i].mean() > MA_EPS):
        v |= 128
    return v


def masks_of(code: str, dates):
    """一次算出一只标的在整个日期轴上的掩码（避免逐日重复解码）"""
    d = decode_pack(open(os.path.join(ROOT, "docs", "data", code[2:] + ".bin"), "rb").read())
    cl = _r2(d["close"]); op = _r2(d["open"]); hi = _r2(d["high"]); lo = _r2(d["low"])
    raw = d["dates"].astype("i8"); n = cl.size
    dif = _ema(cl, 12) - _ema(cl, 26); dea = _ema(dif, 9)
    out = {}
    for date in dates:
        i = int(np.searchsorted(raw, date))
        if i >= n or int(raw[i]) != date or i < FILTER_MIN_IDX:
            out[date] = 0
            continue
        ph = float(hi[max(0, i - FILTER_PRIOR_N):i].max())
        v = 0
        t3 = i - 3
        if (t3 - 5 >= 0 and cl[t3] > cl[t3 - 5] and hi[t3] > 0
                and -0.10 <= cl[i] / hi[t3] - 1 <= -0.03
                and cl[i - 1] < cl[i - 2] and cl[i] < cl[i - 2]):
            v |= 1
        if cl[i] > cl[i - 1] > cl[i - 2]:
            v |= 2
        bullish = cl[i] > op[i]
        if bullish and cl[i] > max(hi[i - 1], hi[i - 2]):
            v |= 4
        if bullish and cl[i] > ph:
            v |= 8
        if dif[i] > dea[i] and dif[i - 1] <= dea[i - 1] and dif[i] < 0:
            v |= 16
        body = abs(cl[i] - op[i])
        big = cl[i - 1] > 0 and body / cl[i - 1] >= 0.06
        hi20 = hi[i - 19:i + 1].max(); lo20 = lo[i - 19:i + 1].min()
        span = hi20 - lo20
        pos = (cl[i] - lo20) / span if span > 0 else 0.5
        if big and bullish and pos <= 0.20:
            v |= 32
        if big and cl[i] < op[i] and pos >= 0.80:
            v |= 64
        if (cl[i - 4:i + 1].mean() - cl[i - 9:i + 1].mean() > MA_EPS
                and cl[i - 9:i + 1].mean() - cl[i - 19:i + 1].mean() > MA_EPS
                and cl[i - 19:i + 1].mean() - cl[i - 59:i + 1].mean() > MA_EPS
                and cl[i - 4:i + 1].mean() - cl[i - 5:i].mean() > MA_EPS
                and cl[i - 9:i + 1].mean() - cl[i - 10:i].mean() > MA_EPS):
            v |= 128
        out[date] = v
    return out


BITS = (1, 2, 4, 8, 16, 32, 64, 128)


def main(n=400):
    """样本 = 随机若干 + **每个条件定向若干**。

    必需这么抽：⑥(0.057%)、⑦(0.019%) 这种条件，纯随机采样几乎永远命中不了，
    校验就等于没验 —— 而它们恰恰是最需要确认 Python/JS 口径一致的地方。
    """
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "index.json"), encoding="utf-8"))
    cal = [int(x) for x in tdx.trading_calendar(start=RANDOM_FROM, end=RANDOM_TO)]
    rng = random.Random(20260922)
    stocks = [s[0] for s in rng.sample(idx["stocks"], 150)]
    cases, seen, per_bit = [], set(), {b: [] for b in BITS}
    for code in stocks:
        ms = masks_of(code, cal)
        for date, m in ms.items():
            key = (code, date)
            if rng.random() < 0.015 and key not in seen:
                seen.add(key); cases.append({"code": code, "date": date, "mask": m})
            for b in BITS:
                if (m & b) and len(per_bit[b]) < 25 and key not in seen:
                    seen.add(key); per_bit[b].append({"code": code, "date": date, "mask": m})
    for b in BITS:
        cases.extend(per_bit[b])
    from collections import Counter
    hit = Counter()
    for c in cases:
        for b in BITS:
            if c["mask"] & b:
                hit[b] += 1
    print(f"样本 {len(cases)} 个；各条件命中数：" +
          " ".join(f"{b}:{hit[b]}" for b in BITS))
    tmp = "/tmp/_filter_cases.json"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cases, f)
    return subprocess.run(["node", os.path.join(HERE, "dump_js_masks.mjs"), tmp], cwd=ROOT).returncode


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 400))
