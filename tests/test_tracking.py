from bottlecheck.tracking import RejectTracker, simulate


def test_queue_matches_bottles_in_order():
    tr = RejectTracker(distance_ticks=1000, window_ticks=50)
    tr.inspected(1, 0, reject=False)
    tr.inspected(2, 300, reject=True)
    assert not tr.at_ejector(1005).fire
    d = tr.at_ejector(1290)
    assert d.bottle_id == 2 and d.fire


def test_removed_bottle_does_not_shift_decisions():
    tr = RejectTracker(distance_ticks=1000, window_ticks=50)
    tr.inspected(1, 0, reject=True)   # снята с ленты до сбрасывателя
    tr.inspected(2, 300, reject=False)
    d = tr.at_ejector(1300)
    assert d.bottle_id == 2 and not d.fire
    assert [a[1] for a in tr.alarms] == ["lost_bottle"]


def test_unknown_bottle_is_ejected_fail_safe():
    tr = RejectTracker(distance_ticks=1000, window_ticks=50)
    d = tr.at_ejector(500)
    assert d.fire and d.reason == "unknown_bottle"


def test_shadow_mode_never_fires():
    tr = RejectTracker(distance_ticks=1000, window_ticks=50, shadow=True)
    tr.inspected(1, 0, reject=True)
    assert not tr.at_ejector(1000).fire
    assert not tr.at_ejector(5000).fire


def test_simulation_clean_line():
    rejects = [i % 7 == 0 for i in range(1000)]
    r = simulate(rejects)
    assert r.ejected_correct == sum(rejects)
    assert r.missed == r.false_ejected == 0 and not r.alarms


def test_simulation_late_verdict_falls_back_to_ejecting():
    r = simulate([False] * 50, latency_ms=5000)
    assert r.missed == 0 and r.false_ejected == 50
