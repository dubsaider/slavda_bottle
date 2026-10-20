"""Правила «замеры -> причины брака» для режима «по эталону».

Одни и те же правила используют сами проверки (reference.check_*, vision.check_level)
и перебор порогов (tradeoff): решение по сохранённым замерам совпадает с решением,
которое приняла бы проверка кадра с теми же порогами.
"""
from __future__ import annotations


def cap(v: dict, c: dict) -> list[str]:
    if "ncc" not in v:  # зона крышки вне кадра — проверять нечего
        return []
    shape_ok = v["ncc"] >= c["min_ncc"] and v["texture"] >= c.get("min_texture", 0.5)
    if shape_ok:
        return ["cap_color"] if v["de"] > c["max_de"] else []
    # Форма не та. Если на месте крышки что-то непохожее и на эталон, и на фон
    # рядом с бутылкой — это крышка другого цвета/типа, иначе крышки нет.
    return ["cap_color"] if v["de"] > c["max_de"] and v["de_bg"] > c["max_de"] else ["no_cap"]


def label(v: dict, c: dict) -> list[str]:
    if v["ncc"] < c["min_ncc"]:
        return ["no_label"]
    out = []
    if abs(v["angle_deg"]) > c["max_angle_deg"]:
        out.append("label_skew")
    if abs(v["shift_mm"]) > c["shift_tol_mm"]:
        out.append("label_shift")
    return out


def level(v: dict, c: dict) -> list[str]:
    if "level_mm" not in v:
        return ["level_not_found"]
    dev = v["level_mm"] - c["target_mm"]
    if dev < -c["tol_mm"]:
        return ["level_low"]
    if dev > c["tol_mm"]:
        return ["level_high"]
    return []


RULES = {"cap": cap, "label": label, "level": level}


def reasons(measurements: dict, recipe: dict) -> dict[str, list[str]]:
    """Причины по каждой проверке кадра; {"locate": ["no_bottle"]}, если бутылки нет."""
    if "locate" in measurements and measurements["locate"].get("score", 0) < recipe["locate"].get("min_score", 0.3):
        return {"locate": ["no_bottle"]}
    return {k: RULES[k](v, recipe[k]) for k, v in measurements.items()
            if k in RULES and k in recipe and recipe[k].get("enabled", True)}


def combine(per_camera: list[dict], recipe: dict) -> dict:
    """Решение по нескольким камерам вокруг бутылки.

    Крышку и уровень судит камера, которая лучше всех нашла бутылку; этикетку —
    камера, которая лучше всех её видит (этикетка видна не со всех сторон).
    -> {"reasons": [...], "primary": i, "label_cam": i | None}
    """
    found = [(i, m) for i, m in enumerate(per_camera) if "locate" not in reasons(m, recipe)]
    if not found:
        return {"reasons": ["no_bottle"], "primary": 0, "label_cam": None}
    primary = max(found, key=lambda im: im[1].get("locate", {}).get("score", 0))[0]
    with_label = [(i, m) for i, m in found if "label" in m]
    label_cam = max(with_label, key=lambda im: im[1]["label"]["ncc"])[0] if with_label else None
    out = []
    for k, rs in reasons(per_camera[primary], recipe).items():
        if k != "label":
            out += rs
    if label_cam is not None:
        out += reasons(per_camera[label_cam], recipe).get("label", [])
    return {"reasons": out, "primary": primary, "label_cam": label_cam}
