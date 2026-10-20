"""Выбор порогов: сколько брака пропускаем и сколько годного выбрасываем.

Замеры кадров сохраняются один раз, дальше пороги рецепта перебираются без
повторной съёмки. «Строгость» s масштабирует все допуски сразу: s < 1 — строже
(меньше пропусков, больше ложных сбросов), s > 1 — мягче.
"""
from __future__ import annotations

import copy

from . import decide

STRICTNESS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5]


def scale(recipe: dict, s: float) -> dict:
    """Рецепт с допусками ×s (пороги сходства сдвигаются в ту же сторону)."""
    r = copy.deepcopy(recipe)
    if "cap" in r:
        c = r["cap"]
        c["min_ncc"] = round(1 - (1 - c["min_ncc"]) * s, 3)
        c["min_texture"] = round(c.get("min_texture", 0.5) / s, 3)
        c["max_de"] = round(c["max_de"] * s, 2)
    if "label" in r:
        c = r["label"]
        c["min_ncc"] = round(1 - (1 - c["min_ncc"]) * s, 3)
        c["max_angle_deg"] = round(c["max_angle_deg"] * s, 2)
        c["shift_tol_mm"] = round(c["shift_tol_mm"] * s, 2)
    if "level" in r:
        r["level"]["tol_mm"] = round(r["level"]["tol_mm"] * s, 2)
    return r


def evaluate(rows: list[dict], recipe: dict) -> dict:
    """rows: {"truth": класс, "cams": [замеры камеры, ...]}. -> доли пропуска и ложных сбросов."""
    bad = good = missed = false = 0
    by_class: dict[str, list[int]] = {}
    for row in rows:
        rej = bool(decide.combine(row["cams"], recipe)["reasons"])
        ok_truth = row["truth"] == "ok"
        c = by_class.setdefault(row["truth"], [0, 0])
        c[0] += 1
        c[1] += rej
        if ok_truth:
            good += 1
            false += rej
        else:
            bad += 1
            missed += not rej
    return {"missed": missed / bad if bad else 0.0, "false": false / good if good else 0.0,
            "bad": bad, "good": good, "by_class": by_class}


def sweep(rows: list[dict], recipe: dict, prevalence: float, cost_false: float, cost_miss: float,
          strictness=STRICTNESS) -> dict:
    """Цена ошибок на 1000 бутылок при доле брака prevalence на линии; лучшая строгость."""
    points = []
    for s in strictness:
        e = evaluate(rows, scale(recipe, s))
        per1000 = 1000 * ((1 - prevalence) * e["false"] * cost_false + prevalence * e["missed"] * cost_miss)
        points.append({"s": s, **e, "cost": round(per1000, 2)})
    best = min(points, key=lambda p: (p["cost"], abs(p["s"] - 1)))
    return {"points": points, "best": best["s"]}
