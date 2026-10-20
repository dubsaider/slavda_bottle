"""Обучение рецепта на годных бутылках: эталон цвета крышки и этикетки, номинал уровня.

Бракованных образцов нет — эталоны снимаются только с годной продукции,
пороги выставляются по разбросу годных с запасом.
"""
from __future__ import annotations

import numpy as np

from . import vision


def calibrate(images, recipe: dict) -> tuple[dict, str]:
    images = [img for _, img in images]
    # Ширина и высота силуэта (с крышкой) завышены на одну и ту же кромку e:
    # w = D*ppm + e, h = Hb*ppm + e  ->  ppm = (h - w) / (Hb - D).
    sizes = []
    for img in images:
        lab = vision.to_lab(img)
        geo = vision.locate(lab, vision.background(lab), recipe)
        if geo is not None:
            sizes.append((geo.w, geo.h))
    if not sizes:
        raise SystemExit("бутылка не найдена ни на одном снимке: проверьте фон и locate.bg_de")
    b = recipe["bottle"]
    w, h = np.median(np.array(sizes, float), axis=0)
    ppm = (h - w) / (b["height_mm"] - b["diameter_mm"])
    edge_px = round(float(w - b["diameter_mm"] * ppm), 1)
    recipe = {**recipe, "locate": {**recipe["locate"], "edge_px": edge_px}}

    caps, labels, levels = [], [], []
    skipped = 0
    for img in images:
        lab = vision.to_lab(img)
        bg = vision.background(lab)
        geo = vision.locate(lab, bg, recipe)
        if geo is None:
            skipped += 1
            continue
        c = recipe["cap"]
        x0, y0, x1, y1 = vision._clip(geo.rect(c["from_mm"], c["to_mm"], c["width_mm"]), lab.shape)
        zone = lab[y0:y1, x0:x1]
        opaque = vision.delta_e(zone, bg) > c["presence_de"]
        if opaque.mean() >= c["min_fill"]:
            caps.append(np.median(zone[opaque], axis=0))
        lc = recipe["label"]
        inset = (lc["top_mm"] - lc["bottom_mm"]) * 0.2
        x0, y0, x1, y1 = vision._clip(
            geo.rect(lc["bottom_mm"] + inset, lc["top_mm"] - inset, lc["width_mm"] * 0.6), lab.shape)
        labels.append(np.median(lab[y0:y1, x0:x1].reshape(-1, 3), axis=0))
        level, _, _ = vision.measure_level(lab, geo, recipe["level"])
        if level is not None:
            levels.append(level)
    if not caps or not labels or not levels:
        raise SystemExit("не удалось измерить эталоны: проверьте фон, свет и геометрию рецепта")

    new = {**recipe, "cap": dict(recipe["cap"]), "label": dict(recipe["label"]), "level": dict(recipe["level"])}
    cap_ref = np.median(caps, axis=0)
    label_ref = np.median(labels, axis=0)
    new["cap"]["ref_lab"] = [round(float(v), 1) for v in cap_ref]
    new["label"]["ref_lab"] = [round(float(v), 1) for v in label_ref]
    new["level"]["target_mm"] = round(float(np.median(levels)), 1)

    cap_de = vision.delta_e(np.array(caps), cap_ref)
    label_de = vision.delta_e(np.array(labels), label_ref)
    report = "\n".join([
        f"годных снимков: {len(labels)} (не найдена бутылка: {skipped})",
        f"масштаб: ~{ppm:.2f} px/мм, поправка на размытие края edge_px={edge_px}",
        f"крышка: эталон Lab {new['cap']['ref_lab']}, ΔE годных p99={np.percentile(cap_de, 99):.1f} "
        f"-> max_de сейчас {recipe['cap']['max_de']}, рекомендуем ≥ {max(5.0, 2 * np.percentile(cap_de, 99)):.0f}",
        f"этикетка: эталон Lab {new['label']['ref_lab']}, ΔE годных p99={np.percentile(label_de, 99):.1f} "
        f"-> match_de сейчас {recipe['label']['match_de']}",
        f"уровень: номинал {new['level']['target_mm']} мм, СКО {np.std(levels):.2f} мм "
        f"-> допуск сейчас ±{recipe['level']['tol_mm']} мм, разброс годных съест {3 * np.std(levels):.1f} мм",
    ])
    return new, report
