"""Инспекция одной бутылки: все проверки рецепта -> «годно / брак + причины»."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import reference, vision

REASONS = {
    "no_bottle": "бутылка не найдена в кадре",
    "no_cap": "нет крышки",
    "cap_color": "неверный цвет крышки",
    "level_low": "недолив",
    "level_high": "перелив",
    "level_not_found": "уровень не найден",
    "no_label": "нет этикетки",
    "label_skew": "перекос этикетки",
    "label_shift": "смещение этикетки",
}


def load_recipe(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_recipe(recipe: dict, path) -> None:
    Path(path).write_text(json.dumps(recipe, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@dataclass
class Verdict:
    ok: bool
    reasons: list[str]
    checks: list[vision.Check] = field(default_factory=list)
    geometry: vision.Geometry | None = None

    def measurements(self) -> dict:
        return {c.name: c.values for c in self.checks}


def enabled(recipe: dict, name: str) -> bool:
    return name in recipe and recipe[name].get("enabled", True)


def inspect(img_bgr: np.ndarray, recipe: dict, thresholds_off: bool = False) -> Verdict:
    """thresholds_off — только измерить (для калибровки порогов по годным)."""
    if recipe.get("mode") == "reference":
        return _inspect_reference(img_bgr, recipe, thresholds_off)
    lab = vision.to_lab(img_bgr)
    bg = vision.background(lab)
    geo = vision.locate(lab, bg, recipe)
    if geo is None:
        # Датчик сработал, а бутылки нет — безопаснее сбросить.
        return Verdict(False, ["no_bottle"])
    checks = []
    if enabled(recipe, "cap"):
        checks.append(vision.check_cap(lab, bg, geo, recipe["cap"]))
    if enabled(recipe, "level"):
        checks.append(vision.check_level(lab, geo, recipe["level"]))
    if enabled(recipe, "label"):
        checks.append(vision.check_label(lab, geo, recipe["label"]))
    reasons = [r for c in checks for r in c.reasons]
    return Verdict(not reasons, reasons, checks, geo)


def _inspect_reference(img_bgr: np.ndarray, recipe: dict, thresholds_off: bool) -> Verdict:
    if thresholds_off:
        recipe = {k: (dict(v) if isinstance(v, dict) else v) for k, v in recipe.items()}
        recipe["locate"]["min_score"] = -1
        for key in ("cap", "label"):
            if key in recipe:
                recipe[key]["min_ncc"] = -1
                recipe[key]["min_texture"] = -1
    R, rect = reference.load_ref(recipe)
    A, score, (k, bx, by) = reference.align(img_bgr, recipe)
    loc = vision.Check("locate", A is not None, values={"score": round(score, 2)})
    if A is None:
        return Verdict(False, ["no_bottle"], [loc])
    d = recipe["bottle"]["diameter_mm"]
    frame_geo = vision.Geometry(int(bx), int(by), int(rect[2] * k), int(rect[3] * k), rect[2] * k / d)
    geo = reference.ref_geometry(recipe)
    checks = [loc]
    if enabled(recipe, "cap"):
        checks.append(reference.check_cap(A, R, geo, recipe["cap"]))
    if enabled(recipe, "level"):
        checks.append(vision.check_level(vision.to_lab(A), geo, recipe["level"]))
    if enabled(recipe, "label"):
        checks.append(reference.check_label(A, R, geo, recipe["label"]))
    for c in checks:
        if c.rect:
            c.rect = reference.to_frame(c.rect, rect, k, bx, by)
    reasons = [r for c in checks for r in c.reasons]
    return Verdict(not reasons, reasons, checks, frame_geo)


def annotate(img_bgr: np.ndarray, v: Verdict) -> np.ndarray:
    out = img_bgr.copy()
    if v.geometry:
        g = v.geometry
        cv2.rectangle(out, (g.x, g.y), (g.x + g.w, g.y + g.h), (160, 160, 160), 1)
    for c in v.checks:
        if c.rect:
            color = (0, 170, 0) if c.ok else (0, 0, 230)
            cv2.rectangle(out, c.rect[:2], c.rect[2:], color, 2)
    text = "OK" if v.ok else "REJECT: " + ",".join(v.reasons)
    cv2.putText(out, text, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (0, 140, 0) if v.ok else (0, 0, 230), 1, cv2.LINE_AA)
    return out
