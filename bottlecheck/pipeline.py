"""Прогон потока снимков: инспекция, решение о сбросе, журнал, архив снимков."""
from __future__ import annotations

import csv
import json
import time
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from . import vision
from .inspection import REASONS, Verdict, annotate, inspect

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp"}
JOURNAL_FIELDS = ["ts", "bottle_id", "source", "sku", "verdict", "reasons",
                  "measurements", "snapshot", "shadow", "ejected"]


def folder_frames(path) -> Iterator[tuple[str, np.ndarray]]:
    for p in sorted(Path(path).iterdir()):
        if p.suffix.lower() in IMAGE_EXT:
            img = cv2.imread(str(p))
            if img is not None:
                yield p.name, img


def camera_frames(index: int, recipe: dict) -> Iterator[tuple[str, np.ndarray]]:
    """Веб-камера/телефон (DroidCam и т.п.). Триггер — «виртуальный фотодатчик»:
    бутылка появилась и встала по центру кадра; пробел — ручной триггер, q — выход.
    """
    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise SystemExit(f"камера {index} не открылась")
    armed, empty = True, 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            lab = vision.to_lab(cv2.resize(frame, None, fx=0.5, fy=0.5))
            geo = vision.locate(lab, vision.background(lab), recipe)
            centered = geo is not None and abs(geo.cx - lab.shape[1] / 2) < 0.1 * lab.shape[1]
            empty = 0 if geo is not None else empty + 1
            if empty >= 5:
                armed = True
            view = frame.copy()
            cv2.putText(view, "ARMED" if armed else "wait: remove bottle", (8, 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 160, 0) if armed else (0, 0, 200), 2)
            cv2.imshow("bottlecheck", view)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord(" ") or (armed and centered):
                armed = False
                yield time.strftime("cam_%H%M%S"), frame
    finally:
        cap.release()
        cv2.destroyAllWindows()


class Journal:
    def __init__(self, out_dir):
        self.dir = Path(out_dir)
        (self.dir / "snapshots").mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "journal.csv"
        new = not self.path.exists()
        self.f = open(self.path, "a", newline="", encoding="utf-8")
        self.w = csv.DictWriter(self.f, JOURNAL_FIELDS)
        if new:
            self.w.writeheader()
        self.next_id = self._last_id() + 1

    def _last_id(self) -> int:
        with open(self.path, encoding="utf-8") as f:
            ids = [int(r["bottle_id"]) for r in csv.DictReader(f)]
        return max(ids, default=-1)

    def write(self, row: dict) -> None:
        self.w.writerow(row)
        self.f.flush()

    def close(self) -> None:
        self.f.close()


def run(frames, recipe: dict, out_dir, shadow: bool = False, save_good_every: int = 20,
        on_verdict=None) -> list[Verdict]:
    journal = Journal(out_dir)
    verdicts = []
    try:
        for source, img in frames:
            bid = journal.next_id
            journal.next_id += 1
            v = inspect(img, recipe)
            snapshot = ""
            if not v.ok or bid % save_good_every == 0:
                snapshot = f"snapshots/{bid:06d}_{'ok' if v.ok else 'rej'}.jpg"
                cv2.imwrite(str(journal.dir / snapshot), annotate(img, v))
            ejected = not v.ok and not shadow
            journal.write({
                "ts": time.strftime("%Y-%m-%d %H:%M:%S"), "bottle_id": bid, "source": source,
                "sku": recipe.get("sku", ""), "verdict": "ok" if v.ok else "reject",
                "reasons": ";".join(v.reasons),
                "measurements": json.dumps(v.measurements(), ensure_ascii=False),
                "snapshot": snapshot, "shadow": int(shadow), "ejected": int(ejected),
            })
            verdicts.append(v)
            if on_verdict:
                on_verdict(bid, source, v, shadow)
    finally:
        journal.close()
    return verdicts


def print_verdict(bid, source, v: Verdict, shadow: bool) -> None:
    if v.ok:
        print(f"#{bid:05d} {source}: годно")
        return
    why = ", ".join(REASONS.get(r, r) for r in v.reasons)
    action = "[тень] был бы СБРОС" if shadow else "СБРОС"
    print(f"#{bid:05d} {source}: {action} — {why}")
