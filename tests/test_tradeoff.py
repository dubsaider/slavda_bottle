"""Решение по сохранённым замерам совпадает с проверкой; перебор порогов и несколько камер."""
import json

import numpy as np

from bottlecheck import decide, simulator, tradeoff, web
from bottlecheck.inspection import inspect, load_recipe

WATER = load_recipe("recipes/water_15.json")


def _rows(n, seed=5, severity="edge"):
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        d = simulator.pick(rng, 0.5, simulator.available(WATER))
        img, _, _ = simulator.frame(WATER, d, rng, severity=severity, jitter=1.5)
        v = inspect(img, WATER)
        rows.append({"truth": d, "cams": [v.measurements()], "reasons": v.reasons})
    return rows


def test_decide_matches_inspection():
    for row in _rows(30):
        assert decide.combine(row["cams"], WATER)["reasons"] == row["reasons"]


def test_strictness_trades_misses_for_false_rejects():
    rows = _rows(40)
    e = [tradeoff.evaluate(rows, tradeoff.scale(WATER, s)) for s in (0.5, 1.0, 2.5)]
    assert e[0]["missed"] <= e[1]["missed"] <= e[2]["missed"]
    assert e[0]["false"] >= e[1]["false"] >= e[2]["false"]
    res = tradeoff.sweep(rows, WATER, prevalence=0.01, cost_false=10, cost_miss=1000)
    assert res["best"] in tradeoff.STRICTNESS and len(res["points"]) == len(tradeoff.STRICTNESS)


def test_combine_takes_label_from_camera_that_sees_it():
    rng = np.random.default_rng(6)
    good, _, _ = simulator.frame(WATER, "ok", rng)
    back, _, _ = simulator.frame(WATER, "no_label", rng)  # камера с обратной стороны этикетки не видит
    out = json.loads(web.inspect_multi(json.dumps([web._to_url(back, 92), web._to_url(good, 92)]), json.dumps(WATER)))
    assert out["ok"] and out["label_cam"] == 1
    out = json.loads(web.inspect_multi(json.dumps([web._to_url(back, 92)] * 2), json.dumps(WATER)))
    assert out["reasons"] == ["no_label"]


def test_no_bottle_in_any_camera():
    empty = np.full((480, 200, 3), 120, np.uint8)
    assert decide.combine([inspect(empty, WATER).measurements()], WATER)["reasons"] == ["no_bottle"]
