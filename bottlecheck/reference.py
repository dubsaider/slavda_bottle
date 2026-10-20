"""Режим «по эталону»: бутылка ищется и проверяется сравнением с эталонным снимком.

Не требует контрастного фона: прозрачная бутылка с белой крышкой на белом фоне
не выделяется по цвету, но её контуры, рёбра, крышка и этикетка находятся
сопоставлением с эталоном (нормированная корреляция). Эталон — снимок одной
годной бутылки, на котором вручную обведены бутылка и этикетка.

Координаты зон — в мм от дна, как и в обычном режиме, но отсчитываются
по эталонному снимку, к которому приводится каждый новый кадр.
"""
from __future__ import annotations

import base64
import math

import cv2
import numpy as np

from . import vision

REF_H = 400      # высота бутылки в сохранённом эталоне, px
WORK_H = 140     # высота бутылки при грубом поиске, px


def _gray(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)


def _grad(img: np.ndarray) -> np.ndarray:
    g = _gray(img) if img.ndim == 3 else img
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.GaussianBlur(cv2.magnitude(gx, gy), (0, 0), 1.2)


def encode_image(img: np.ndarray) -> str:
    _, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return "data:image/jpeg;base64," + base64.b64encode(enc.tobytes()).decode()


def decode_image(url: str) -> np.ndarray:
    data = base64.b64decode(url.split(",", 1)[1])
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


_cache: dict = {}


def load_ref(recipe: dict) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    ref = recipe["reference"]
    key = ref["image"][-64:] + str(len(ref["image"]))
    if key not in _cache:
        _cache.clear()
        _cache[key] = decode_image(ref["image"])
    return _cache[key], tuple(int(v) for v in ref["rect"])


def ref_geometry(recipe: dict) -> vision.Geometry:
    _, (x, y, w, h) = load_ref(recipe)
    return vision.Geometry(x, y, w, h, w / recipe["bottle"]["diameter_mm"])


# ---------- поиск и выравнивание ----------

def anchor_mask(recipe: dict, shape, rect) -> np.ndarray:
    """Маска частей бутылки, по которым её выравнивать (1 — использовать).

    Выкидываем то, что может законно поменяться: этикетку с запасом на сдвиг
    (иначе сдвинутая этикетка «утащит» за собой всю бутылку) и середину зоны
    уровня (иначе за бутылкой поедет линия воды). Контур бутылки, крышка и дно остаются.
    """
    x, y, w, h = rect
    m = np.ones(shape[:2], np.float32)
    geo = vision.Geometry(x, y, w, h, w / recipe["bottle"]["diameter_mm"])
    lab = recipe.get("label")
    if lab and lab.get("enabled", True):
        sm = lab.get("search_mm", 15)
        y0, y1 = int(geo.row(lab["top_mm"] + sm)), int(geo.row(lab["bottom_mm"] - sm))
        m[max(0, y0):max(0, y1)] = 0
    lvl = recipe.get("level")
    if lvl and lvl.get("enabled", True):
        y0, y1 = int(geo.row(lvl["search_to_mm"])), int(geo.row(lvl["search_from_mm"]))
        m[max(0, y0):max(0, y1), int(x + 0.15 * w):int(x + 0.85 * w)] = 0
    return m


def _match(image, templ, mask):
    res = cv2.matchTemplate(image, templ, cv2.TM_CCOEFF_NORMED, mask=mask)
    return np.nan_to_num(res, nan=-1.0, posinf=-1.0, neginf=-1.0)


def _coarse(img, R, rect, mask, scales):
    """Грубый поиск по контурам на уменьшенном кадре. -> (score, k, x, y) в координатах кадра."""
    x, y, w, h = rect
    f = WORK_H / h
    G = _grad(cv2.resize(R, None, fx=f, fy=f, interpolation=cv2.INTER_AREA))
    M = cv2.resize(mask, (G.shape[1], G.shape[0]), interpolation=cv2.INTER_NEAREST)
    tx, ty, tw, th = (int(round(v * f)) for v in rect)
    T, TM = G[ty:ty + th, tx:tx + tw], M[ty:ty + th, tx:tx + tw]
    best = (-1.0, 1.0, 0, 0)
    for k in scales:  # k — масштаб кадра относительно эталона
        s = f / k
        I = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        if I.shape[0] < T.shape[0] or I.shape[1] < T.shape[1]:
            continue
        _, score, _, loc = cv2.minMaxLoc(_match(_grad(I), T, TM))
        if score > best[0]:
            best = (float(score), float(k), loc[0] / s, loc[1] / s)
    return best


def _warp(img, R_shape, rect, k, bx, by):
    """Кадр -> координаты эталона: бутылка ложится на рамку rect."""
    x, y, _, _ = rect
    # ref_pt = (img_pt - (bx, by)) / k + (x, y)
    M = np.float32([[1 / k, 0, x - bx / k], [0, 1 / k, y - by / k]])
    return cv2.warpAffine(img, M, (R_shape[1], R_shape[0]), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def align(img: np.ndarray, recipe: dict):
    """-> (выровненный кадр того же размера, что эталон, | None, score, (k, bx, by))."""
    R, rect = load_ref(recipe)
    cfg = recipe.get("locate", {})
    lo, hi = cfg.get("scale_range", [0.8, 1.25])
    mask = anchor_mask(recipe, R.shape, rect)
    # эталон хранится в своём разрешении: base — ожидаемый масштаб кадра к эталону
    base = 1.0 / recipe["reference"].get("scale", 1.0)
    score, k, bx, by = _coarse(img, R, rect, mask, base * np.geomspace(lo, hi, 12))
    if score < cfg.get("min_score", 0.3):
        return None, score, (k, bx, by)
    # Уточнение на полном разрешении эталона: сдвиг ±pad px и масштаб ±2%.
    x, y, w, h = rect
    Tg, TM = _grad(R)[y:y + h, x:x + w], mask[y:y + h, x:x + w]
    pad = 10
    best = (-1.0, k, bx, by)
    for kk in k * np.array([0.98, 0.99, 1.0, 1.01, 1.02]):
        A = _warp(img, R.shape, rect, kk, bx, by)
        G = _grad(A)
        y0, x0 = max(0, y - pad), max(0, x - pad)
        region = G[y0:y + h + pad, x0:x + w + pad]
        if region.shape[0] < h or region.shape[1] < w:
            continue
        _, s, _, loc = cv2.minMaxLoc(_match(region, Tg, TM))
        if s > best[0]:
            dx, dy = loc[0] + x0 - x, loc[1] + y0 - y
            best = (float(s), float(kk), bx + dx * kk, by + dy * kk)
    score, k, bx, by = best
    return _warp(img, R.shape, rect, k, bx, by), max(score, 0.0), (k, bx, by)


# ---------- проверки в координатах эталона ----------

def _zone(geo, from_mm, to_mm, width_mm, shape):
    return vision._clip(geo.rect(from_mm, to_mm, width_mm), shape)


def _texture(img, zone) -> float:
    """Энергия контуров в верхней части зоны крышки (рифление, грани, тени)."""
    x0, y0, x1, y1 = zone
    h, w = y1 - y0, x1 - x0
    g = _gray(img)[y0:y0 + max(2, int(0.75 * h)), x0 + int(0.1 * w):x1 - int(0.1 * w)]
    if g.size == 0:
        return 0.0
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return float(np.abs(gx).mean() + np.abs(gy).mean())


def check_cap(A, R, geo, c) -> vision.Check:
    """Крышки нет, если пропало её рифление (текстура) или она не похожа на эталон.

    Первое ловит крышку на гладком фоне, второе — на фоне с рисунком.
    Цвет сравнивается с эталоном по ΔE.
    """
    x0, y0, x1, y1 = _zone(geo, c["from_mm"], c["to_mm"], c["width_mm"], R.shape)
    rect = (x0, y0, x1, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return vision.Check("cap", True, rect=rect)
    pad = 3  # бутылка уже выровнена; большой запас находит «крышку» в резьбе горлышка
    Rz = _grad(R)[y0:y1, x0:x1]
    GA = _grad(A)
    ay0, ax0 = max(0, y0 - pad), max(0, x0 - pad)
    region = GA[ay0:y1 + pad, ax0:x1 + pad]
    res = cv2.matchTemplate(region, Rz, cv2.TM_CCOEFF_NORMED)
    _, ncc, _, loc = cv2.minMaxLoc(res)
    texture = _texture(A, rect) / max(1e-3, _texture(R, rect))
    chk = vision.Check("cap", True, values={"ncc": round(float(ncc), 2), "texture": round(texture, 2)}, rect=rect)
    shape_ok = ncc >= c["min_ncc"] and texture >= c.get("min_texture", 0.5)
    sx, sy = (ax0 + loc[0], ay0 + loc[1]) if shape_ok else (x0, y0)
    lab = vision.to_lab(A[sy:sy + (y1 - y0), sx:sx + (x1 - x0)])
    color = np.median(lab.reshape(-1, 3), axis=0)
    de = float(vision.delta_e(color, c["ref_lab"]))
    chk.values.update(lab=[round(float(v), 1) for v in color], de=round(de, 1))
    if shape_ok:
        if de > c["max_de"]:
            chk.ok, chk.reasons = False, ["cap_color"]
        return chk
    # Форма не та. Если на месте крышки что-то непохожее и на эталон, и на фон
    # рядом с бутылкой — это крышка другого цвета/типа, иначе крышки нет.
    bx0, bx1 = max(0, geo.x - int(0.25 * geo.w)), geo.x - 2
    side = vision.to_lab(A[y0:y1, bx0:bx1]) if bx1 > bx0 else lab
    de_bg = float(vision.delta_e(color, np.median(side.reshape(-1, 3), axis=0)))
    chk.values["de_bg"] = round(de_bg, 1)
    chk.ok = False
    chk.reasons = ["cap_color"] if de > c["max_de"] and de_bg > c["max_de"] else ["no_cap"]
    return chk


def _rotate(img, angle_deg, center):
    M = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def _edge_angle(gA, gR, rect, search_px):
    """Наклон этикетки по её верхнему и нижнему краю относительно эталона.

    Для каждого столбца ищем строку, где перепад яркости такой же, как на краю
    этикетки в эталоне; по точкам — прямая. -> (угол°, сдвиг px, надёжно ли).
    """
    x0, y0, x1, y1 = rect
    gyA = cv2.Sobel(gA, cv2.CV_32F, 0, 1, ksize=3)
    gyR = cv2.Sobel(gR, cv2.CV_32F, 0, 1, ksize=3)
    cols = np.arange(x0 + int(0.1 * (x1 - x0)), x1 - int(0.1 * (x1 - x0)), 2)
    if len(cols) < 6:
        return 0.0, 0.0, False
    slopes, offsets, strong = [], [], []
    for edge in (y0, y1):
        lo, hi = max(1, edge - 4), min(gR.shape[0] - 1, edge + 5)
        prof = gyR[lo:hi, cols].mean(axis=1)
        if not prof.size:
            continue
        r_ref = lo + int(np.argmax(np.abs(prof)))
        sign = np.sign(prof[r_ref - lo]) or 1.0
        ref_strength = abs(prof[r_ref - lo])
        a, b = max(1, r_ref - search_px), min(gA.shape[0] - 1, r_ref + search_px + 1)
        win = sign * cv2.blur(gyA, (3, 1))[a:b, cols]
        rows = a + win.argmax(axis=0)
        vals = win.max(axis=0)
        fit = np.polyfit(cols, rows, 1)
        keep = np.abs(np.polyval(fit, cols) - rows) < 3
        if keep.sum() >= 6:
            fit = np.polyfit(cols[keep], rows[keep], 1)
        slopes.append(fit[0])
        offsets.append(np.polyval(fit, (x0 + x1) / 2) - r_ref)
        strong.append(np.median(vals) > 0.35 * ref_strength and keep.mean() > 0.6)
    if not slopes:
        return 0.0, 0.0, False
    return math.degrees(math.atan(float(np.mean(slopes)))), float(np.mean(offsets)), all(strong)


def check_label(A, R, geo, c) -> vision.Check:
    """Ищем эталонную этикетку в окрестности её места, перебирая наклон."""
    x0, y0, x1, y1 = _zone(geo, c["bottom_mm"], c["top_mm"], c["width_mm"], R.shape)
    rect = (x0, y0, x1, y1)
    T = cv2.GaussianBlur(_gray(R)[y0:y1, x0:x1], (0, 0), 1.0)
    my = int(c.get("search_mm", 15) * geo.px_per_mm)
    mx = int(0.06 * (x1 - x0)) + 2
    gA = cv2.GaussianBlur(_gray(A), (0, 0), 1.0)
    cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
    ry0, rx0 = max(0, y0 - my), max(0, x0 - mx)
    best = (-1.0, 0.0, 0)
    step = c.get("angle_step_deg", 1.5)
    for ang in np.arange(-c.get("angle_search_deg", 12), c.get("angle_search_deg", 12) + 1e-6, step):
        # поворачиваем кадр на -ang: если этикетка наклонена на ang, она выпрямится
        rot = _rotate(gA, -ang, (cx, cy)) if ang else gA
        region = rot[ry0:y1 + my, rx0:x1 + mx]
        if region.shape[0] < T.shape[0] or region.shape[1] < T.shape[1]:
            continue
        res = cv2.matchTemplate(region, T, cv2.TM_CCOEFF_NORMED)
        _, s, _, loc = cv2.minMaxLoc(res)
        if s > best[0]:
            best = (float(s), float(ang), loc[1] + ry0 - y0)
    ncc, angle, dy = best
    chk = vision.Check("label", True, values={"ncc": round(ncc, 2)}, rect=rect)
    if ncc < c["min_ncc"]:
        chk.ok, chk.reasons = False, ["no_label"]
        return chk
    # Края этикетки точнее поворота картинки: на цилиндре бока этикетки
    # остаются вертикальными, наклоняются только верхний и нижний край.
    # Края на цилиндре видны дугой со своим наклоном — меряем так же на эталоне и вычитаем.
    gR = cv2.GaussianBlur(_gray(R), (0, 0), 1.0)
    e_angle, e_dy, reliable = _edge_angle(gA, gR, rect, my)
    r_angle, r_dy, _ = _edge_angle(gR, gR, rect, my)
    if reliable:
        angle, dy = -(e_angle - r_angle), e_dy - r_dy
    shift = -dy / geo.px_per_mm
    chk.values.update(angle_deg=round(angle, 1), shift_mm=round(shift, 1))
    if abs(angle) > c["max_angle_deg"]:
        chk.reasons.append("label_skew")
    if abs(shift) > c["shift_tol_mm"]:
        chk.reasons.append("label_shift")
    chk.ok = not chk.reasons
    return chk


def to_frame(rect, ref_rect, k, bx, by):
    """Прямоугольник из координат эталона в координаты кадра (для аннотации)."""
    x, y, _, _ = ref_rect
    x0, y0, x1, y1 = rect
    f = lambda px, py: (int(round((px - x) * k + bx)), int(round((py - y) * k + by)))
    return (*f(x0, y0), *f(x1, y1))


# ---------- создание рецепта по эталонному снимку ----------

def make_recipe(img: np.ndarray, bottle_rect, diameter_mm: float, label_rect=None, *,
                cap_diameter_mm: float = 30, cap_height_mm: float = 18,
                sku: str = "my-sku", base: dict | None = None) -> tuple[dict, list[str]]:
    """bottle_rect/label_rect — (x, y, w, h) в пикселях кадра. -> (рецепт, замечания)."""
    notes = []
    x, y, w, h = (int(v) for v in bottle_rect)
    s = REF_H / h
    mx, my = int(0.3 * w), int(0.1 * h)
    X0, Y0 = x - mx, y - my
    P = max(w, h)
    big = cv2.copyMakeBorder(img, P, P, P, P, cv2.BORDER_REPLICATE)
    crop = big[Y0 + P: y + h + my + P, X0 + P: x + w + mx + P]
    R = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    rect = [int(round(mx * s)), int(round(my * s)), int(round(w * s)), int(round(h * s))]
    ppm = rect[2] / diameter_mm
    height_mm = round(rect[3] / ppm, 1)
    geo = vision.Geometry(*rect, ppm)
    base = base or {}

    cap_to = height_mm - 0.12 * cap_height_mm
    cap_from = height_mm - 0.88 * cap_height_mm
    cap_w = 0.85 * cap_diameter_mm
    cx0, cy0, cx1, cy1 = _zone(geo, cap_from, cap_to, cap_w, R.shape)
    cap_lab = np.median(vision.to_lab(R[cy0:cy1, cx0:cx1]).reshape(-1, 3), axis=0)

    recipe = {
        "sku": sku,
        "mode": "reference",
        "bottle": {"diameter_mm": diameter_mm, "height_mm": height_mm},
        "reference": {"image": encode_image(R), "rect": rect, "scale": round(s, 5)},
        "locate": {"min_score": 0.3, "scale_range": [0.8, 1.25]},
        "cap": {"enabled": True, "from_mm": round(cap_from, 1), "to_mm": round(cap_to, 1),
                "width_mm": round(cap_w, 1), "min_ncc": 0.65, "min_texture": 0.5, "max_de": 15,
                "ref_lab": [round(float(v), 1) for v in cap_lab]},
    }
    if label_rect is not None:
        lx, ly, lw, lh = label_rect
        top_mm = geo.mm((ly - Y0) * s)
        bottom_mm = geo.mm((ly + lh - Y0) * s)
        width_mm = min(lw * s / ppm, diameter_mm) * 0.9
        recipe["label"] = {"enabled": True, "bottom_mm": round(bottom_mm, 1), "top_mm": round(top_mm, 1),
                           "width_mm": round(width_mm, 1), "min_ncc": 0.5, "max_angle_deg": 3,
                           "shift_tol_mm": 4, "search_mm": 15}
        level_from = top_mm + 3
    else:
        notes.append("этикетка не отмечена — проверка этикетки выключена")
        level_from = height_mm * 0.5
    level_to = height_mm - cap_height_mm - 1
    level = {"enabled": True, "search_from_mm": round(level_from, 1), "search_to_mm": round(level_to, 1),
             "strip_mm": round(max(4.0, 0.25 * cap_diameter_mm), 1), "gradient_px": 3,
             "min_contrast": 4, "target_mm": 0, "tol_mm": 4}
    lvl, contrast, _ = vision.measure_level(vision.to_lab(R), geo, level)
    amb = vision.level_ambiguity(vision.to_lab(R), geo, level)
    if lvl is None or level_to - level_from < 10:
        level["enabled"] = False
        notes.append("граница воды не видна (контраст %.1f) — проверка уровня выключена; "
                     "нужна подсветка сзади: экран с белой картинкой за бутылкой" % contrast)
    elif amb > 0.6:
        level["enabled"] = False
        notes.append("в зоне уровня несколько похожих границ (рельеф бутылки, блики: вторая — %d%% "
                     "от первой) — уровень прыгал бы между ними, проверка выключена; нужна подсветка "
                     "сзади, чтобы линия воды стала самой контрастной" % round(100 * amb))
    else:
        level["target_mm"] = round(lvl, 1)
    recipe["level"] = level
    for key in ("cap", "label", "level"):
        if key in recipe and key in base and "enabled" in base[key]:
            recipe[key]["enabled"] = recipe[key]["enabled"] and base[key]["enabled"]
    return recipe, notes


def calibrate(images, recipe: dict) -> tuple[dict, str]:
    """Пороги по нескольким годным снимкам: ниже худшего годного с запасом."""
    from .inspection import inspect
    caps, textures, labels, angles, shifts, levels, scores, des, missed = [], [], [], [], [], [], [], [], 0
    for _, img in images:
        v = inspect(img, recipe, thresholds_off=True)
        if v.geometry is None:
            missed += 1
            continue
        m = v.measurements()
        scores.append(m["locate"]["score"])
        if "cap" in m and "ncc" in m["cap"]:
            caps.append(m["cap"]["ncc"])
            textures.append(m["cap"]["texture"])
            des.append(m["cap"].get("de", 0))
        if "label" in m and "ncc" in m["label"]:
            labels.append(m["label"]["ncc"])
            angles.append(m["label"].get("angle_deg", 0))
            shifts.append(m["label"].get("shift_mm", 0))
        if "level" in m and "level_mm" in m["level"]:
            levels.append(m["level"]["level_mm"])
    if not scores:
        raise SystemExit("бутылка не найдена ни на одном снимке: переснимите эталон")
    new = {k: (dict(v) if isinstance(v, dict) else v) for k, v in recipe.items()}
    lines = [f"годных снимков: {len(scores)} (не найдена: {missed}); сходство с эталоном мин {min(scores):.2f}"]
    new["locate"]["min_score"] = round(max(0.2, min(0.3, min(scores) - 0.15)), 2)
    if caps:
        new["cap"]["min_ncc"] = round(max(0.0, min(0.75, min(caps) - 0.15)), 2)
        new["cap"]["min_texture"] = round(max(0.2, min(0.6, min(textures) - 0.3)), 2)
        new["cap"]["max_de"] = round(max(8.0, 2 * float(np.percentile(des, 95))), 1)
        lines.append(f"крышка: сходство мин {min(caps):.2f} -> порог {new['cap']['min_ncc']}; "
                     f"рифление мин {min(textures):.2f} -> порог {new['cap']['min_texture']}; "
                     f"ΔE p95 {np.percentile(des, 95):.1f} -> max_de {new['cap']['max_de']}")
    if labels:
        new["label"]["min_ncc"] = round(max(0.25, min(0.6, min(labels) - 0.15)), 2)
        lines.append(f"этикетка: сходство мин {min(labels):.2f} -> порог {new['label']['min_ncc']}; "
                     f"наклон до {max(map(abs, angles)):.1f}°, сдвиг до {max(map(abs, shifts)):.1f} мм")
    if levels:
        new["level"]["target_mm"] = round(float(np.median(levels)), 1)
        lines.append(f"уровень: номинал {new['level']['target_mm']} мм, разброс ±{3 * np.std(levels):.1f} мм "
                     f"(допуск ±{new['level']['tol_mm']} мм)")
    return new, "\n".join(lines)
