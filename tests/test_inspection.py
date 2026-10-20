import numpy as np
import pytest

from bottlecheck import synth
from bottlecheck.inspection import inspect, load_recipe

RECIPE = load_recipe("recipes/demo_05.json")
# Перелив у самого горла иногда уходит за зону поиска — это тоже брак по уровню.
ACCEPT = {"level_high": {"level_high", "level_not_found"}}


@pytest.mark.parametrize("defect", synth.DEFECTS)
def test_defect_detected_with_right_reason(defect):
    rng = np.random.default_rng(42)
    for _ in range(15):
        v = inspect(synth.render(defect, rng), RECIPE)
        if defect == "ok":
            assert v.ok, v.reasons
        else:
            assert not v.ok
            assert set(v.reasons) & ACCEPT.get(defect, {defect}), v.reasons


def test_empty_frame_is_rejected():
    frame = np.full((640, 360, 3), 235, np.uint8)
    v = inspect(frame, RECIPE)
    assert not v.ok and v.reasons == ["no_bottle"]
