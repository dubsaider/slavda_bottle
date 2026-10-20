"""Симулятор по эталонному снимку: годные проходят, нарисованный брак ловится."""
import json

import numpy as np
import pytest

from bottlecheck import reference, simulator, synth, vision, web
from bottlecheck.inspection import inspect, load_recipe

WATER = load_recipe("recipes/water_15.json")


def test_available_follows_recipe():
    assert simulator.available(WATER) == ["no_cap", "cap_color", "no_label", "label_skew", "label_shift"]
    assert simulator.available(load_recipe("recipes/demo_05.json")) == synth.DEFECTS[1:]


def test_good_bottles_pass():
    rng = np.random.default_rng(1)
    for _ in range(20):
        img, _, _ = simulator.frame(WATER, "ok", rng)
        v = inspect(img, WATER)
        assert v.ok, (v.reasons, v.measurements())


@pytest.mark.parametrize("defect", simulator.available(WATER))
def test_defects_caught(defect):
    rng = np.random.default_rng(2)
    for _ in range(6):
        img, _, _ = simulator.frame(WATER, defect, rng)
        assert defect in inspect(img, WATER).reasons


def test_label_shift_is_measured_as_drawn():
    R, _ = reference.load_ref(WATER)
    geo = reference.ref_geometry(WATER)
    for shift in (-3, 3):
        B = R.copy()
        simulator._move_label(B, WATER, geo, 0, shift)
        F = simulator._camera(B, WATER["reference"]["rect"], WATER["reference"]["scale"],
                              np.random.default_rng(0), 0.0, 0)[0]
        got = inspect(F, WATER).measurements()["label"]["shift_mm"]
        assert abs(got - shift) < 1.0, got


def test_level_defects_on_reference_with_visible_level():
    info = {}
    img = synth.render("ok", np.random.default_rng(100), cap=(235, 235, 235), label=(225, 235, 240), info=info)
    r, notes = reference.make_recipe(img, info["bottle"], 65, info["label"], cap_diameter_mm=30, cap_height_mm=15)
    assert r["level"]["enabled"], notes
    rng = np.random.default_rng(3)
    for defect in ("level_low", "level_high", "ok"):
        frame, _, _ = simulator.frame(r, defect, rng)
        v = inspect(frame, r)
        assert (v.ok if defect == "ok" else defect in v.reasons), (defect, v.reasons, v.measurements())


def test_ambiguous_level_is_disabled():
    """На фото без подсветки сзади рельеф бутылки даёт несколько равных границ."""
    R, rect = reference.load_ref(WATER)
    lvl = dict(WATER["level"], enabled=True)
    amb = vision.level_ambiguity(vision.to_lab(R), reference.ref_geometry(WATER), lvl)
    assert amb > 0.6
    assert not WATER["level"]["enabled"]


def test_web_sim_batch():
    out = json.loads(web.sim_batch(0, 3, json.dumps({"seed": 1, "defect_rate": 1.0, "defects": ["no_cap"]}),
                                   json.dumps(WATER)))
    assert [r["truth"] for r in out] == ["no_cap"] * 3
    assert all(not r["ok"] and r["thumb"].startswith("data:image/jpeg") for r in out)
