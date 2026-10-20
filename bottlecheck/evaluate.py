"""Метрики приёмки из КП: пропуск брака по классам и ложная отбраковка.

Эталон — labels.csv (file, defect): разметка синтетики, контрольного набора
или учёт ручной отбраковки в режиме «тени».
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path

# Целевые значения из КП (предложение для этапа 0).
MISS_TARGETS = {
    "no_cap": 0.01, "level_low": 0.01, "level_high": 0.01,
    "cap_color": 0.05, "no_label": 0.05, "label_skew": 0.05, "label_shift": 0.05,
}
FALSE_REJECT_TARGET = 0.005


def _read(path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def evaluate(journal_path, labels_path) -> tuple[str, bool]:
    truth = {r["file"]: r["defect"] for r in _read(labels_path)}
    rows = [r for r in _read(journal_path) if r["source"] in truth]
    if not rows:
        return "нет пересечения журнала с разметкой", False

    per = defaultdict(Counter)
    false_rejects = Counter()
    for r in rows:
        d = truth[r["source"]]
        rejected = r["verdict"] == "reject"
        reasons = r["reasons"].split(";") if r["reasons"] else []
        per[d]["n"] += 1
        if d == "ok":
            if rejected:
                per[d]["rej"] += 1
                false_rejects.update(reasons)
        else:
            per[d]["caught"] += rejected
            per[d]["right_reason"] += d in reasons

    lines = [f"{'класс':<12}{'n':>6}{'пропуск':>10}{'цель':>8}{'причина верна':>15}"]
    passed = True
    for d, target in MISS_TARGETS.items():
        c = per.get(d)
        if not c:
            continue
        miss = 1 - c["caught"] / c["n"]
        ok = miss <= target
        passed &= ok
        lines.append(f"{d:<12}{c['n']:>6}{miss:>9.1%}{'' if ok else '!':1}{target:>7.0%}"
                     f"{c['right_reason'] / c['n']:>15.0%}")
    total = len(rows)
    fr = per["ok"]["rej"] / total
    passed &= fr <= FALSE_REJECT_TARGET
    lines.append(f"\nложная отбраковка: {per['ok']['rej']} из {total} в потоке = {fr:.2%} "
                 f"(цель ≤ {FALSE_REJECT_TARGET:.1%})")
    if false_rejects:
        lines.append("  причины ложных сбросов: " + ", ".join(f"{k}={v}" for k, v in false_rejects.most_common()))
    lines.append("ИТОГ: " + ("критерии выполнены" if passed else "критерии НЕ выполнены"))
    return "\n".join(lines), passed


def feedback_summary(out_dir) -> str:
    out = Path(out_dir)
    if not (out / "feedback.csv").exists():
        return "отметок оператора нет"
    marks = {}
    for r in _read(out / "feedback.csv"):
        marks[r["bottle_id"]] = r["mark"]  # последняя отметка побеждает
    c = Counter(marks.values())
    total = len(_read(out / "journal.csv"))
    return (f"отметки оператора: подтверждён брак={c['confirmed']}, ложная отбраковка={c['false_reject']}, "
            f"пропущенный брак={c['missed']}; ложная отбраковка по отметкам = {c['false_reject'] / max(1, total):.2%} потока")
