"""Инспекция одной бутылки: все проверки рецепта -> «годно / брак + причины»."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import vision

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


def inspect(img_bgr: np.ndarray, recipe: dict) -> Verdict:
    lab = vision.to_lab(img_bgr)
    bg = vision.background(lab)
    geo = vision.locate(lab, bg, recipe)
    if geo is None:
        # Датчик сработал, а бутылки нет — безопаснее сбросить.
        return Verdict(False, ["no_bottle"])
    checks = []
    if "cap" in recipe:
        checks.append(vision.check_cap(lab, bg, geo, recipe["cap"]))
    if "level" in recipe:
        checks.append(vision.check_level(lab, geo, recipe["level"]))
    if "label" in recipe:
        checks.append(vision.check_label(lab, geo, recipe["label"]))
    reasons = [r for c in checks for r in c.reasons]
    return Verdict(not reasons, reasons, checks, geo)


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
