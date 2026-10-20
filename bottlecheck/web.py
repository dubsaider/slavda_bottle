"""Мост для браузерной версии (GitHub Pages + Pyodide).

Тот же код проверок, что и в CLI; на входе кадры RGBA из canvas или data-URL,
на выходе JSON-строки, которые разбирает web/app.js.
"""
from __future__ import annotations

import base64
import json
from dataclasses import asdict

import cv2
import numpy as np

from . import decide, reference, simulator, synth, tradeoff, vision
from .calibrate import calibrate
from .evaluate import evaluate_rows
from .inspection import REASONS, annotate, inspect
from .tracking import simulate


def _from_rgba(rgba, w: int, h: int) -> np.ndarray:
    buf = rgba.to_bytes() if hasattr(rgba, "to_bytes") else bytes(rgba)
    return cv2.cvtColor(np.frombuffer(buf, np.uint8).reshape(h, w, 4), cv2.COLOR_RGBA2BGR)


def _to_url(img: np.ndarray, quality: int = 80) -> str:
    _, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return "data:image/jpeg;base64," + base64.b64encode(enc.tobytes()).decode()


def _from_url(url: str) -> np.ndarray:
    data = base64.b64decode(url.split(",", 1)[1])
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


def _result(img: np.ndarray, recipe: dict, raw: bool = False) -> dict:
    v = inspect(img, recipe)
    out = {"ok": v.ok, "reasons": v.reasons, "measurements": v.measurements(),
           "image": _to_url(annotate(img, v))}
    if raw:
        out["raw"] = _to_url(img, 90)
    return out


def reasons_json() -> str:
    return json.dumps({"reasons": REASONS, "defects": synth.DEFECTS}, ensure_ascii=False)


def inspect_frame(rgba, w: int, h: int, recipe_json: str) -> str:
    return json.dumps(_result(_from_rgba(rgba, w, h), json.loads(recipe_json)), ensure_ascii=False)


def probe(rgba, w: int, h: int, recipe_json: str) -> str:
    """Виртуальный фотодатчик: есть ли бутылка и стоит ли она по центру кадра."""
    recipe = json.loads(recipe_json)
    if recipe.get("mode") == "reference":
        img = _from_rgba(rgba, w, h)
        R, rect = reference.load_ref(recipe)
        base = 1.0 / recipe["reference"].get("scale", 1.0)
        lo, hi = recipe["locate"].get("scale_range", [0.8, 1.25])
        mask = reference.anchor_mask(recipe, R.shape, rect)
        score, k, bx, _ = reference._coarse(img, R, rect, mask, base * np.geomspace(lo, hi, 6))
        found = bool(score >= recipe["locate"].get("min_score", 0.3))
        cx = bx + rect[2] * k / 2
        return json.dumps({"found": found, "centered": bool(found and abs(cx - w / 2) < 0.1 * w),
                           "score": round(score, 2)})
    lab = vision.to_lab(_from_rgba(rgba, w, h))
    geo = vision.locate(lab, vision.background(lab), recipe)
    centered = geo is not None and abs(geo.cx - w / 2) < 0.1 * w
    return json.dumps({"found": geo is not None, "centered": centered})


def synth_batch(start: int, count: int, defect_rate: float, seed: int, recipe_json: str) -> str:
    recipe = json.loads(recipe_json)
    out = []
    for i in range(start, start + count):
        rng = np.random.default_rng([seed, i])
        defect = synth.pick_defect(rng, defect_rate)
        r = _result(synth.render(defect, rng), recipe, raw=True)
        r.update(truth=defect, source=f"synth_{seed}_{i:05d}")
        out.append(r)
    return json.dumps(out, ensure_ascii=False)


def calibrate_json(raw_urls_json: str, recipe_json: str) -> str:
    urls = json.loads(raw_urls_json)
    try:
        new, report = calibrate(((str(i), _from_url(u)) for i, u in enumerate(urls)),
                                json.loads(recipe_json))
    except SystemExit as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)
    return json.dumps({"recipe": new, "report": report}, ensure_ascii=False)


def evaluate_json(rows_json: str) -> str:
    report, passed = evaluate_rows(json.loads(rows_json))
    return json.dumps({"report": report, "passed": passed}, ensure_ascii=False)


def simulate_json(rejects_json: str, params_json: str) -> str:
    res = simulate(json.loads(rejects_json), **json.loads(params_json))
    return json.dumps({"report": res.report(), **asdict(res)}, ensure_ascii=False)


def make_reference_json(raw_url: str, params_json: str) -> str:
    """Рецепт «по эталону» из снимка годной бутылки и рамок, нарисованных пользователем."""
    p = json.loads(params_json)
    img = _from_url(raw_url)
    try:
        recipe, notes = reference.make_recipe(
            img, p["bottle"], float(p["diameter_mm"]), p.get("label"),
            cap_diameter_mm=float(p.get("cap_diameter_mm", 30)),
            cap_height_mm=float(p.get("cap_height_mm", 18)),
            sku=p.get("sku") or "my-sku", base=p.get("checks"))
    except Exception as e:  # кривые рамки и т.п. — показать пользователю, а не упасть
        return json.dumps({"error": f"не получилось: {e}"}, ensure_ascii=False)
    check = _result(img, recipe)
    if not check["ok"]:
        notes.append("эталонный снимок сам не проходит проверку: " + ", ".join(
            REASONS.get(r, r) for r in check["reasons"]) + " — проверьте рамки")
    return json.dumps({"recipe": recipe, "notes": notes, "check": check}, ensure_ascii=False)


def sim_info(recipe_json: str) -> str:
    """Что симулятор умеет рисовать для текущего рецепта."""
    recipe = json.loads(recipe_json)
    b = recipe.get("bottle", {})
    return json.dumps({"defects": simulator.available(recipe), "reference": recipe.get("mode") == "reference",
                       "diameter_mm": b.get("diameter_mm", 65), "height_mm": b.get("height_mm", 205)})


def sim_batch(start: int, count: int, params_json: str, recipe_json: str) -> str:
    """Кадры виртуального конвейера: бутылка по эталону -> проверка -> решение."""
    p, recipe = json.loads(params_json), json.loads(recipe_json)
    defects = [d for d in p.get("defects", simulator.available(recipe)) if d in simulator.available(recipe)]
    blur = simulator.blur_px(recipe, p.get("speed_mm_s", 250), p.get("exposure_ms", 1))
    out = []
    for i in range(start, start + count):
        rng = np.random.default_rng([p.get("seed", 0), i])
        defect = simulator.pick(rng, p.get("defect_rate", 0.3), defects)
        img, (x, y, w, h), info = simulator.frame(recipe, defect, rng, severity=p.get("severity", "clear"),
                                                  jitter=p.get("jitter", 1.0), blur_px=blur)
        m = int(0.02 * h)
        crop = img[max(0, y - m):y + h + m, max(0, x - m):x + w + m]
        thumb = cv2.resize(crop, None, fx=160 / crop.shape[0], fy=160 / crop.shape[0], interpolation=cv2.INTER_AREA)
        r = _result(img, recipe)
        r.update(truth=defect, info=info, thumb=_to_url(thumb, 85), source=f"sim_{p.get('seed', 0)}_{i:05d}")
        out.append(r)
    return json.dumps(out, ensure_ascii=False)


def inspect_url(raw_url: str, recipe_json: str) -> str:
    """Проверка кадра, пришедшего как data-URL (кадры виртуальной камеры 3D-линии)."""
    return json.dumps(_result(_from_url(raw_url), json.loads(recipe_json)), ensure_ascii=False)


def inspect_multi(raw_urls_json: str, recipe_json: str) -> str:
    """Кадры нескольких камер одной бутылки -> общее решение (decide.combine)."""
    recipe = json.loads(recipe_json)
    cams = [_result(_from_url(u), recipe) for u in json.loads(raw_urls_json)]
    d = decide.combine([c["measurements"] for c in cams], recipe)
    return json.dumps({"ok": not d["reasons"], "reasons": d["reasons"], "primary": d["primary"],
                       "label_cam": d["label_cam"], "cams": cams,
                       "image": cams[d["label_cam"] if d["label_cam"] is not None else d["primary"]]["image"],
                       "measurements": [c["measurements"] for c in cams]}, ensure_ascii=False)


def tradeoff_json(rows_json: str, recipe_json: str, params_json: str) -> str:
    p = json.loads(params_json)
    return json.dumps(tradeoff.sweep(json.loads(rows_json), json.loads(recipe_json), p["prevalence"],
                                     p["cost_false"], p["cost_miss"]), ensure_ascii=False)


def scale_recipe_json(recipe_json: str, s: float) -> str:
    return json.dumps(tradeoff.scale(json.loads(recipe_json), float(s)), ensure_ascii=False)
