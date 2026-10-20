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

from . import synth, vision
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
    lab = vision.to_lab(_from_rgba(rgba, w, h))
    geo = vision.locate(lab, vision.background(lab), json.loads(recipe_json))
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
