"""Синтетические снимки бутылки 0,5 л сбоку с заданными дефектами.

Нужны, чтобы прогнать механику отбраковки до появления камеры и реальных
образцов брака. Геометрия совпадает с recipes/demo_05.json.
"""
from __future__ import annotations

import csv
import math
from pathlib import Path

import cv2
import numpy as np

DEFECTS = ["ok", "no_cap", "cap_color", "level_low", "level_high",
           "no_label", "label_skew", "label_shift"]

W, H = 360, 640
# Контур бутылки (x от оси, y от дна), мм: корпус -> плечики -> горло.
OUTLINE = [(-32.5, 0), (32.5, 0), (32.5, 130), (13, 170), (13, 190),
           (-13, 190), (-13, 170), (-32.5, 130)]
GLASS = (190, 200, 195)
EDGE = (120, 130, 125)
LIQUID = (165, 190, 180)
MENISCUS = (105, 115, 115)
LABEL = (50, 140, 60)
CAP = (40, 40, 190)
WRONG_CAPS = [(180, 80, 30), (30, 120, 220), (40, 160, 40), (60, 60, 110)]


def _jitter(color, rng, amp):
    return tuple(float(np.clip(c + rng.uniform(-amp, amp), 0, 255)) for c in color)


def render(defect: str, rng: np.random.Generator, cap=CAP, label=LABEL, info: dict | None = None):
    """info — если передан словарь, в него пишутся рамки бутылки и этикетки (x, y, w, h)."""
    ppm = rng.uniform(2.6, 2.9)
    cx = W / 2 + rng.uniform(-25, 25)
    bottom = H - 15 - rng.uniform(0, 10)

    def px(x_mm, y_mm):
        return [cx + x_mm * ppm, bottom - y_mm * ppm]

    bg = 235 + rng.uniform(-6, 6)
    img = np.full((H, W, 3), bg, np.uint8)

    poly = np.array([px(*p) for p in OUTLINE], np.int32)
    body = np.zeros((H, W), np.uint8)
    cv2.fillPoly(body, [poly], 1)
    img[body > 0] = GLASS
    inner = cv2.erode(body, np.ones((5, 5), np.uint8))

    level = {"level_low": rng.uniform(160, 166),
             "level_high": rng.uniform(184.5, 187.5)}.get(defect, 175 + rng.normal(0, 1.0))
    lrow = int(round(bottom - level * ppm))
    liquid = inner.copy()
    liquid[:lrow] = 0
    img[liquid > 0] = LIQUID
    band = np.zeros_like(inner)
    band[lrow:lrow + 3] = 1
    img[(band & inner) > 0] = MENISCUS

    if defect != "no_label":
        angle = rng.choice([-1, 1]) * rng.uniform(6, 10) if defect == "label_skew" else rng.normal(0, 0.5)
        shift = rng.choice([-1, 1]) * rng.uniform(8, 12) if defect == "label_shift" else rng.normal(0, 0.7)
        c_y = 75 + shift
        a = math.radians(angle)
        corners = []
        for x, y in [(-40, -35), (40, -35), (40, 35), (-40, 35)]:
            corners.append(px(x * math.cos(a) - y * math.sin(a), c_y + x * math.sin(a) + y * math.cos(a)))
        lmask = np.zeros_like(body)
        cv2.fillPoly(lmask, [np.array(corners, np.int32)], 1)
        img[(lmask & body) > 0] = _jitter(label, rng, 6)
        org = px(-22, c_y - 4)
        cv2.putText(img, "SLAVDA", (int(org[0]), int(org[1])), cv2.FONT_HERSHEY_DUPLEX,
                    0.024 * ppm * 6, (30, 30, 30), 2, cv2.LINE_AA)

    cv2.polylines(img, [poly], True, EDGE, 2, cv2.LINE_AA)

    if defect != "no_cap":
        wrong = [c for c in WRONG_CAPS if np.abs(np.subtract(c, cap)).sum() > 120]
        color = wrong[rng.integers(len(wrong))] if defect == "cap_color" else cap
        p0, p1 = px(-15, 205), px(15, 190)
        cv2.rectangle(img, (int(p0[0]), int(p0[1])), (int(p1[0]), int(p1[1])),
                      _jitter(color, rng, 8), -1)
        rib = tuple(0.8 * c for c in color)  # рифление крышки, как у настоящей
        for xm in np.arange(-13.5, 14, 2.5):
            xr = int(px(xm, 0)[0])
            cv2.line(img, (xr, int(p0[1]) + 2), (xr, int(p1[1]) - 3), rib, 1)
        cv2.line(img, (int(p0[0]), int(p1[1]) - 2), (int(p1[0]), int(p1[1]) - 2), rib, 1)

    if info is not None:
        x0, y0 = px(-32.5, 205)
        x1, y1 = px(32.5, 0)
        info["bottle"] = (int(x0), int(y0), int(x1 - x0), int(y1 - y0))
        lx0, ly0 = px(-32.5, 110)
        lx1, ly1 = px(32.5, 40)
        info["label"] = (int(lx0), int(ly0), int(lx1 - lx0), int(ly1 - ly0))
    noisy = img.astype(np.float32) + rng.normal(0, 2.0, img.shape)
    return np.clip(noisy, 0, 255).astype(np.uint8)


def pick_defect(rng: np.random.Generator, defect_rate: float) -> str:
    return DEFECTS[1 + rng.integers(len(DEFECTS) - 1)] if rng.random() < defect_rate else "ok"


def generate(out_dir, n: int, defect_rate: float = 0.3, seed: int = 0) -> Path:
    """Пишет n снимков и labels.csv (file, defect)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    with open(out / "labels.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["file", "defect"])
        for i in range(n):
            defect = pick_defect(rng, defect_rate)
            name = f"{i:05d}_{defect}.png"
            cv2.imwrite(str(out / name), render(defect, rng))
            w.writerow([name, defect])
    return out
