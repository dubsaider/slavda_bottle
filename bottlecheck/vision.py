"""Классическое зрение: поиск бутылки в кадре и проверки по рецепту SKU.

Все зоны контроля в рецепте заданы в миллиметрах от дна бутылки. Масштаб
(px/мм) берётся из ширины найденной бутылки, поэтому камеру не нужно
калибровать: достаточно, чтобы бутылка стояла боком к камере на однородном фоне.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import decide


def to_lab(bgr: np.ndarray) -> np.ndarray:
    """BGR uint8 -> CIE Lab float32 (L 0..100)."""
    return cv2.cvtColor(bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)


def delta_e(lab: np.ndarray, ref) -> np.ndarray:
    """ΔE76 между пикселями и эталонным цветом."""
    return np.linalg.norm(lab - np.asarray(ref, np.float32), axis=-1)


def background(lab: np.ndarray, border: int = 8) -> np.ndarray:
    """Цвет фона — медиана по рамке кадра."""
    edge = np.concatenate([
        lab[:border].reshape(-1, 3), lab[-border:].reshape(-1, 3),
        lab[:, :border].reshape(-1, 3), lab[:, -border:].reshape(-1, 3),
    ])
    return np.median(edge, axis=0)


@dataclass
class Geometry:
    x: int
    y: int
    w: int
    h: int
    px_per_mm: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def row(self, mm: float) -> float:
        return self.bottom - mm * self.px_per_mm

    def mm(self, row: float) -> float:
        return (self.bottom - row) / self.px_per_mm

    def rect(self, from_mm: float, to_mm: float, width_mm: float) -> tuple[int, int, int, int]:
        half = width_mm * self.px_per_mm / 2
        return (int(round(self.cx - half)), int(round(self.row(to_mm))),
                int(round(self.cx + half)), int(round(self.row(from_mm))))


@dataclass
class Check:
    name: str
    ok: bool
    reasons: list[str] = field(default_factory=list)
    values: dict = field(default_factory=dict)
    rect: tuple[int, int, int, int] | None = None


def _clip(rect, shape):
    x0, y0, x1, y1 = rect
    h, w = shape[:2]
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def locate(lab: np.ndarray, bg: np.ndarray, recipe: dict) -> Geometry | None:
    cfg = recipe["locate"]
    mask = (delta_e(lab, bg) > cfg["bg_de"]).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    if n < 2:
        return None
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, area = stats[i]
    if area < cfg["min_area_frac"] * mask.size:
        return None
    # Силуэт шире бутылки на размытие края (оптика, ореол подсветки, морфология);
    # поправку edge_px находит calibrate по пропорциям годной бутылки.
    width = max(1.0, w - cfg.get("edge_px", 0))
    return Geometry(int(x), int(y), int(w), int(h), width / recipe["bottle"]["diameter_mm"])


def check_cap(lab, bg, geo: Geometry, c: dict) -> Check:
    rect = geo.rect(c["from_mm"], c["to_mm"], c["width_mm"])
    x0, y0, x1, y1 = _clip(rect, lab.shape)
    zone = lab[y0:y1, x0:x1]
    opaque = delta_e(zone, bg) > c["presence_de"]
    fill = float(opaque.mean()) if opaque.size else 0.0
    chk = Check("cap", True, values={"fill": round(fill, 3)}, rect=rect)
    if fill < c["min_fill"]:
        chk.ok, chk.reasons = False, ["no_cap"]
        return chk
    color = np.median(zone[opaque], axis=0)
    de = float(delta_e(color, c["ref_lab"]))
    chk.values.update(lab=[round(float(v), 1) for v in color], de=round(de, 1))
    if de > c["max_de"]:
        chk.ok, chk.reasons = False, ["cap_color"]
    return chk


def measure_level(lab, geo: Geometry, c: dict) -> tuple[float | None, float, tuple]:
    """Граница мениска по вертикальному профилю яркости в узкой полосе по оси.

    Ищем самый сильный переход «темно снизу -> светло сверху». Работает и для
    окрашенного продукта, и для прозрачной воды на просвет (тёмная линия мениска).
    """
    rect = geo.rect(c["search_from_mm"], c["search_to_mm"], c["strip_mm"])
    x0, y0, x1, y1 = _clip(rect, lab.shape)
    k = c.get("gradient_px", 3)
    if y1 - y0 <= k + 3 or x1 <= x0:
        return None, 0.0, rect
    prof = lab[y0:y1, x0:x1, 0].mean(axis=1)
    prof = np.convolve(prof, np.ones(3) / 3, mode="valid")  # сдвиг на 1 строку
    d = prof[:-k] - prof[k:]
    i = int(np.argmax(d))
    contrast = float(d[i])
    if contrast < c["min_contrast"]:
        return None, contrast, rect
    return geo.mm(y0 + 1 + i + k / 2), contrast, rect


def level_ambiguity(lab, geo: Geometry, c: dict) -> float:
    """Сила второй по величине границы в зоне уровня относительно первой (0..1).

    Близко к 1 — в зоне несколько одинаково сильных перепадов (рельеф бутылки,
    блики), и «уровень» будет прыгать между ними от бутылки к бутылке.
    """
    rect = geo.rect(c["search_from_mm"], c["search_to_mm"], c["strip_mm"])
    x0, y0, x1, y1 = _clip(rect, lab.shape)
    k = c.get("gradient_px", 3)
    if y1 - y0 <= k + 3 or x1 <= x0:
        return 1.0
    prof = np.convolve(lab[y0:y1, x0:x1, 0].mean(axis=1), np.ones(3) / 3, mode="valid")
    d = prof[:-k] - prof[k:]
    i = int(np.argmax(d))
    if d[i] <= 0:
        return 1.0
    sup = int(3 * geo.px_per_mm)  # соседние строки того же перепада не считаются
    rest = np.concatenate([d[:max(0, i - sup)], d[i + sup + 1:]])
    return float(max(0.0, rest.max()) / d[i]) if rest.size else 0.0


def check_level(lab, geo: Geometry, c: dict) -> Check:
    level, contrast, rect = measure_level(lab, geo, c)
    chk = Check("level", True, values={"contrast": round(contrast, 1)}, rect=rect)
    if level is not None:
        chk.values.update(level_mm=round(level, 1), dev_mm=round(level - c["target_mm"], 1))
    chk.reasons = decide.level(chk.values, c)
    chk.ok = not chk.reasons
    return chk


def check_label(lab, geo: Geometry, c: dict) -> Check:
    m = c["search_margin_mm"]
    rect = geo.rect(c["bottom_mm"] - m, c["top_mm"] + m, c["width_mm"])
    x0, y0, x1, y1 = _clip(rect, lab.shape)
    zone = lab[y0:y1, x0:x1]
    mask = (delta_e(zone, c["ref_lab"]) < c["match_de"]).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    label_h = (c["top_mm"] - c["bottom_mm"]) * geo.px_per_mm
    coverage = float(mask.sum()) / max(1.0, label_h * (x1 - x0))
    chk = Check("label", True, values={"coverage": round(coverage, 2)}, rect=rect)
    cols = np.where(mask.sum(axis=0) > 0.3 * label_h)[0]
    if coverage < c["min_coverage"] or len(cols) < 5:
        chk.ok, chk.reasons = False, ["no_label"]
        return chk
    sub = mask[:, cols].astype(bool)
    tops = sub.argmax(axis=0)
    bottoms = sub.shape[0] - 1 - sub[::-1].argmax(axis=0)
    slope = (np.polyfit(cols, tops, 1)[0] + np.polyfit(cols, bottoms, 1)[0]) / 2
    angle = math.degrees(math.atan(slope))
    center_mm = geo.mm(y0 + (tops.mean() + bottoms.mean()) / 2)
    shift = center_mm - (c["top_mm"] + c["bottom_mm"]) / 2
    chk.values.update(angle_deg=round(angle, 1), shift_mm=round(shift, 1))
    if abs(angle) > c["max_angle_deg"]:
        chk.reasons.append("label_skew")
    if abs(shift) > c["shift_tol_mm"]:
        chk.reasons.append("label_shift")
    chk.ok = not chk.reasons
    return chk
