# -*- coding: utf-8 -*-
"""筛选索引一致性验证：filter.bin 的生成口径（Python）必须与前端判定（JS）逐位一致。

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

from tools.build_data import (FILTER_PRIOR_N, RANDOM_FROM, RANDOM_TO,
                              _ema, _r2, decode_pack)  # noqa: E402
from src import tdx  # noqa: E402
import numpy as np  # noqa: E402


def mask_of(code: str, date: int) -> int:
    """与 build_filter 完全相同的实现（唯一区别：只算一天）"""
    d = decode_pack(open(os.path.join(ROOT, "docs", "data", code[2:] + ".bin"), "rb").read())
    cl = _r2(d["close"]); op = _r2(d["open"]); hi = _r2(d["high"]); dates = d["dates"].astype("i8")
    n = cl.size
    i = int(np.searchsorted(dates, date))
    if i >= n or int(dates[i]) != date or i < 70:
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
    if bullish and op[i] > max(hi[i - 1], hi[i - 2]):
        v |= 4
    if bullish and op[i] > ph:
        v |= 8
    if dif[i] > dea[i] and dif[i - 1] <= dea[i - 1] and dif[i] < 0:
        v |= 16
    return v


def main(n=400):
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "index.json"), encoding="utf-8"))
    cal = [int(x) for x in tdx.trading_calendar(start=RANDOM_FROM, end=RANDOM_TO)]
    rng = random.Random(20260922)
    cases = []
    for _ in range(n):
        s = rng.choice(idx["stocks"])
        cases.append({"code": s[0], "date": rng.choice(cal), "mask": mask_of(s[0], rng.choice(cal))})
    # 上面 mask_of 用的是一个随机日期，修正为与 date 一致
    cases = []
    for _ in range(n):
        code = rng.choice(idx["stocks"])[0]
        date = rng.choice(cal)
        cases.append({"code": code, "date": date, "mask": mask_of(code, date)})
    tmp = "/tmp/_filter_cases.json"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cases, f)
    from collections import Counter
    c = Counter(bin(x["mask"]).count("1") for x in cases)
    print(f"Python 侧样本 {len(cases)} 个，命中条件数分布：{dict(sorted(c.items()))}")
    return subprocess.run(["node", os.path.join(HERE, "dump_js_masks.mjs"), tmp], cwd=ROOT).returncode


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 400))
