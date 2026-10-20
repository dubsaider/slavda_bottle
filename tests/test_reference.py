"""Режим «по эталону» на синтетике: белая крышка и белая этикетка на белом фоне,
где поиск по цвету фона не работает."""
import numpy as np
import pytest

from bottlecheck import reference, synth
from bottlecheck.inspection import inspect

WHITE_CAP = (235, 235, 235)
PALE_LABEL = (225, 235, 240)


@pytest.fixture(scope="module")
def recipe():
    info = {}
    img = synth.render("ok", np.random.default_rng(100), cap=WHITE_CAP, label=PALE_LABEL, info=info)
    r, _ = reference.make_recipe(img, info["bottle"], 65, info["label"], cap_diameter_mm=30, cap_height_mm=15)
    rng = np.random.default_rng(50)
    r, _ = reference.calibrate([(str(i), _render("ok", rng)) for i in range(10)], r)
    return r


def _render(defect, rng):
    return synth.render(defect, rng, cap=WHITE_CAP, label=PALE_LABEL)


def test_good_bottles_pass(recipe):
    rng = np.random.default_rng(1)
    for _ in range(15):
        v = inspect(_render("ok", rng), recipe)
        assert v.ok, (v.reasons, v.measurements())


@pytest.mark.parametrize("defect", ["no_cap", "no_label", "label_skew", "label_shift", "level_low", "level_high"])
def test_defects_caught(recipe, defect):
    rng = np.random.default_rng(2)
    for _ in range(10):
        v = inspect(_render(defect, rng), recipe)
        assert defect in v.reasons, (v.reasons, v.measurements())


def test_wrong_cap_color(recipe):
    rng = np.random.default_rng(3)
    for _ in range(10):
        v = inspect(_render("cap_color", rng), recipe)
        assert "cap_color" in v.reasons, (v.reasons, v.measurements())




def test_calibrate_keeps_good_passing(recipe):
    rng = np.random.default_rng(4)
    goods = [(str(i), _render("ok", rng)) for i in range(10)]
    new, report = reference.calibrate(goods, recipe)
    assert "годных снимков: 10" in report
    assert all(inspect(img, new).ok for _, img in goods)


def test_empty_frame(recipe):
    v = inspect(np.full((640, 360, 3), 235, np.uint8), recipe)
    assert v.reasons == ["no_bottle"]
