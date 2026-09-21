# -*- coding: utf-8 -*-
"""导出某只标的的 docs/data/*.bin 解码结果，作为前端解码器的对照样本（tests/fixtures/）。

用法： python tools/dump_fixture.py 600000 300750
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from tools.build_data import decode_pack  # noqa: E402

OUT = os.path.join(ROOT, "tests", "fixtures")


def main(codes):
    os.makedirs(OUT, exist_ok=True)
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "index.json"), encoding="utf-8"))
    meta = {s[0][2:]: s for s in idx["stocks"]}
    for c in codes:
        c6 = c[-6:]
        blob = open(os.path.join(ROOT, "docs", "data", c6 + ".bin"), "rb").read()
        d = decode_pack(blob)
        entry = meta.get(c6, [c6, c6, 0, 0, 0, 0, -1])
        obj = {
            "code": entry[0], "name": entry[1], "boardIdx": entry[2],
            "n": entry[3], "prior": entry[4], "iFrom": entry[5], "iTo": entry[6],
            "dates": [int(x) for x in d["dates"]],
            "open": [round(float(x), 4) for x in d["open"]],
            "high": [round(float(x), 4) for x in d["high"]],
            "low": [round(float(x), 4) for x in d["low"]],
            "close": [round(float(x), 4) for x in d["close"]],
            "vol": [round(float(x), 1) for x in d["vol"]],
            "binBytes": len(blob),
        }
        p = os.path.join(OUT, c6 + ".json")
        json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print(f"{c6} {entry[1]} {obj['n']} bars -> {p} ({os.path.getsize(p)} B)")


if __name__ == "__main__":
    main(sys.argv[1:] or ["600000", "300750", "688256", "000001"])
