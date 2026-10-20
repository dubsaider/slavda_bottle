"""Поток бутылок для виртуального конвейера по эталонному снимку.

Из одного снимка годной бутылки (рецепт «по эталону») получаются кадры камеры:
годные — с разбросом, как на линии (положение, масштаб, наклон, свет, шум, смаз),
бракованные — с дефектом, нарисованным по зонам рецепта.

Дефекты из одного снимка «чище» настоящих: бутылка без крышки получается заменой
крышки фоном, без этикетки — продолжением корпуса над этикеткой. Это проверка
логики и порогов рецепта, а не замена живым снимкам брака.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from . import reference, synth, vision

# Чужие цвета крышки (BGR); берутся только достаточно далёкие от эталона.
CAP_COLORS = [(40, 40, 200), (190, 90, 30), (40, 160, 40), (30, 200, 230), (35, 35, 35), (235, 235, 235)]
SEVERITY = {"clear": (1.5, 3.0), "edge": (1.1, 1.6)}  # во сколько раз дефект больше допуска


def available(recipe: dict) -> list[str]:
    """Дефекты, которые рецепт проверяет и которые можно нарисовать."""
    if recipe.get("mode") != "reference":
        return synth.DEFECTS[1:]
    on = lambda k: k in recipe and recipe[k].get("enabled", True)
    out = []
    if on("cap"):
        out += ["no_cap", "cap_color"]
    if on("level"):
        out += ["level_low", "level_high"]
    if on("label"):
        out += ["no_label", "label_skew", "label_shift"]
    return out


def pick(rng: np.random.Generator, defect_rate: float, defects: list[str]) -> str:
    if not defects or rng.random() >= defect_rate:
        return "ok"
    return defects[int(rng.integers(len(defects)))]


# ---------- дефекты в координатах эталона ----------

def _cap_box(recipe, geo):
    c = recipe["cap"]
    cap_h = (c["to_mm"] - c["from_mm"]) / 0.76
    cap_w = c["width_mm"] / 0.85
    top = recipe["bottle"]["height_mm"]
    return geo.rect(top - cap_h, top + 2, cap_w * 1.12)


def _background_fill(B, geo, rect):
    """Залить прямоугольник фоном, взятым слева от бутылки на тех же строках."""
    x0, y0, x1, y1 = vision._clip(rect, B.shape)
    src = B[y0:y1, max(0, geo.x - int(0.25 * geo.w)):max(1, geo.x - 2)]
    if src.shape[1] < 2:
        src = B[y0:y1, :2]
    reps = math.ceil((x1 - x0) / src.shape[1]) + 1
    tile = np.concatenate([src, src[:, ::-1]] * reps, axis=1)[:, :x1 - x0]
    B[y0:y1, x0:x1] = cv2.GaussianBlur(tile, (0, 0), 1.5)


def no_cap(B, recipe, geo, rng):
    _background_fill(B, geo, _cap_box(recipe, geo))


def cap_color(B, recipe, geo, rng):
    x0, y0, x1, y1 = vision._clip(_cap_box(recipe, geo), B.shape)
    ref = np.asarray(recipe["cap"]["ref_lab"], np.float32)
    far = [c for c in CAP_COLORS
           if vision.delta_e(vision.to_lab(np.uint8([[c]]))[0, 0], ref) > 3 * recipe["cap"]["max_de"]]
    color = far[int(rng.integers(len(far)))] if far else (40, 40, 200)
    target = vision.to_lab(np.uint8([[color]]))[0, 0]
    lab = vision.to_lab(B[y0:y1, x0:x1])
    # Рифление и тени (отклонения яркости) остаются, тон и средняя яркость — от новой крышки.
    lab[..., 0] = np.clip(target[0] + 0.6 * (lab[..., 0] - ref[0]), 0, 100)
    lab[..., 1], lab[..., 2] = target[1], target[2]
    B[y0:y1, x0:x1] = np.clip(cv2.cvtColor(lab, cv2.COLOR_Lab2BGR) * 255, 0, 255).astype(np.uint8)


def _label_rows(recipe, geo, B):
    c = recipe["label"]
    # рамку этикетки рисуют от руки: с запасом, чтобы край этикетки не остался на месте
    pad = max(2.0, 0.08 * (c["top_mm"] - c["bottom_mm"])) * geo.px_per_mm
    y0 = int(max(0, geo.row(c["top_mm"]) - pad))
    y1 = int(min(B.shape[0], geo.row(c["bottom_mm"]) + pad))
    return y0, y1, max(0, geo.x - 1), min(B.shape[1], geo.x + geo.w + 1)


def _erase_label(B, recipe, geo):
    """Вместо этикетки — корпус: полоса над этикеткой, повторённая вниз с отражением."""
    y0, y1, x0, x1 = _label_rows(recipe, geo, B)
    sh = max(4, min(y0, int(6 * geo.px_per_mm)))
    strip = B[y0 - sh:y0, x0:x1]
    reps = math.ceil((y1 - y0) / sh) + 1
    fill = np.concatenate([strip[::-1], strip] * reps, axis=0)[:y1 - y0]
    B[y0:y1, x0:x1] = fill


def _move_label(B, recipe, geo, angle_deg=0.0, shift_mm=0.0):
    """Сдвинуть этикетку вверх (shift > 0) и повернуть; бока бутылки не трогать."""
    if not angle_deg and not shift_mm:
        return
    y0, y1, x0, x1 = _label_rows(recipe, geo, B)
    patch = B[y0:y1, x0:x1].copy()
    _erase_label(B, recipe, geo)
    h, w = patch.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    M[1, 2] -= shift_mm * geo.px_per_mm
    big = int(abs(shift_mm) * geo.px_per_mm + 0.5 * w * abs(math.sin(math.radians(angle_deg)))) + 2
    out_h = h + 2 * big
    M[1, 2] += big
    warped = cv2.warpAffine(patch, M, (w, out_h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    mask = cv2.warpAffine(np.ones((h, w), np.uint8), M, (w, out_h), flags=cv2.INTER_NEAREST)
    ty0 = y0 - big
    a, b = max(0, ty0), min(B.shape[0], ty0 + out_h)
    region = B[a:b, x0:x1]
    m = mask[a - ty0:b - ty0].astype(bool)
    region[m] = warped[a - ty0:b - ty0][m]


def _move_level(B, recipe, geo, d_mm):
    """Сдвинуть линию воды на d_mm (вверх > 0) растяжением строк зоны поиска уровня."""
    c = recipe["level"]
    a, b = int(geo.row(c["search_to_mm"])), int(geo.row(c["search_from_mm"]))
    L = geo.row(c["target_mm"])
    L2 = min(b - 3, max(a + 3, L - d_mm * geo.px_per_mm))
    if b - a < 8 or not a < L < b:
        return
    y = np.arange(a, b, dtype=np.float32)
    src = np.where(y <= L2, a + (y - a) * (L - a) / (L2 - a), L + (y - L2) * (b - L) / (b - L2))
    x0, x1 = max(0, geo.x - 1), min(B.shape[1], geo.x + geo.w + 1)
    map_x = np.tile(np.arange(x0, x1, dtype=np.float32), (len(y), 1))
    map_y = np.tile(src[:, None], (1, x1 - x0)).astype(np.float32)
    B[a:b, x0:x1] = cv2.remap(B, map_x, map_y, cv2.INTER_LINEAR)


def apply(B, recipe, defect, rng, severity="clear", jitter=1.0) -> dict:
    """Нарисовать дефект и естественный разброс годной бутылки. -> истинные отклонения."""
    geo = reference.ref_geometry(recipe)
    lo, hi = SEVERITY.get(severity, SEVERITY["clear"])
    sign = 1 if rng.random() < 0.5 else -1
    info = {}
    lab = recipe.get("label") if available(recipe).count("no_label") else None
    lvl = recipe.get("level") if "level_low" in available(recipe) else None
    if lvl:
        tol = lvl["tol_mm"]
        d = {"level_low": -tol * rng.uniform(lo, hi), "level_high": tol * rng.uniform(lo, hi)}.get(
            defect, rng.normal(0, tol / 4 * jitter))
        _move_level(B, recipe, geo, d)
        info["level_mm"] = round(float(d), 1)
    if defect == "no_cap":
        no_cap(B, recipe, geo, rng)
    elif defect == "cap_color":
        cap_color(B, recipe, geo, rng)
    if lab:
        if defect == "no_label":
            _erase_label(B, recipe, geo)
        else:
            ang = sign * lab["max_angle_deg"] * rng.uniform(lo, hi) if defect == "label_skew" \
                else rng.normal(0, lab["max_angle_deg"] / 5 * jitter)
            sh = sign * lab["shift_tol_mm"] * rng.uniform(lo, hi) if defect == "label_shift" \
                else rng.normal(0, lab["shift_tol_mm"] / 5 * jitter)
            _move_label(B, recipe, geo, ang, sh)
            info.update(label_angle=round(float(ang), 1), label_shift_mm=round(float(sh), 1))
    return info


# ---------- кадр камеры ----------

def _camera(B, rect, scale, rng, jitter, blur_px):
    """Эталонные координаты -> кадр камеры с разбросом положения, света и смазом."""
    x, y, w, h = rect
    k = (1 / scale) * (1 + rng.normal(0, 0.015 * jitter))
    ang = rng.normal(0, 0.8 * jitter)
    dx, dy = rng.normal(0, 0.04 * w * jitter), rng.normal(0, 0.015 * h * jitter)
    out = (int(round(B.shape[1] / scale)), int(round(B.shape[0] / scale)))
    c = (x + w / 2, y + h)  # середина дна: наклон и масштаб вокруг неё
    M = cv2.getRotationMatrix2D(c, ang, k)
    # дно ложится туда же, где оно на кадре без разброса, плюс смещение
    M[0, 2] += c[0] / scale - c[0] + dx
    M[1, 2] += c[1] / scale - c[1] + dy
    F = cv2.warpAffine(B, M, out, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    if blur_px >= 1:
        n = int(round(blur_px))
        kern = np.zeros((1, n), np.float32)
        kern[:] = 1 / n
        F = cv2.filter2D(F, -1, kern)
    F = F.astype(np.float32) * (1 + rng.normal(0, 0.05 * jitter)) + rng.normal(0, 4 * jitter)
    F += rng.normal(0, 2.0, F.shape)
    corners = cv2.transform(np.float32([[[x, y]], [[x + w, y + h]]]), M)
    (fx0, fy0), (fx1, fy1) = corners[0, 0], corners[1, 0]
    box = (int(fx0), int(fy0), int(fx1 - fx0), int(fy1 - fy0))
    return np.clip(F, 0, 255).astype(np.uint8), box


def frame(recipe: dict, defect: str, rng: np.random.Generator, *, severity="clear",
          jitter=1.0, blur_px=0.0) -> tuple[np.ndarray, tuple[int, int, int, int], dict]:
    """-> (кадр BGR, рамка бутылки в кадре (x, y, w, h), истинные отклонения)."""
    if recipe.get("mode") != "reference":
        info = {}
        img = synth.render(defect, rng, info=info)
        return img, info["bottle"], {}
    R, rect = reference.load_ref(recipe)
    B = R.copy()
    info = apply(B, recipe, defect, rng, severity, jitter)
    img, box = _camera(B, rect, recipe["reference"].get("scale", 1.0), rng, jitter, blur_px)
    return img, box, info


def blur_px(recipe: dict, speed_mm_s: float, exposure_ms: float) -> float:
    """Смаз за выдержку в пикселях кадра: путь ленты за выдержку × масштаб."""
    if recipe.get("mode") == "reference":
        _, rect = reference.load_ref(recipe)
        ppm = rect[2] / recipe["reference"].get("scale", 1.0) / recipe["bottle"]["diameter_mm"]
    else:
        ppm = 2.75
    return speed_mm_s * exposure_ms / 1000 * ppm
