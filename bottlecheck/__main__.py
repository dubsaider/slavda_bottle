"""CLI прототипа: python -m bottlecheck <команда> --help"""
from __future__ import annotations

import argparse
import csv
import random

from . import synth
from .calibrate import calibrate
from .evaluate import evaluate
from .inspection import load_recipe, save_recipe
from .pipeline import camera_frames, folder_frames, print_verdict, run
from .tracking import simulate


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bottlecheck", description="Прототип отбраковки бутылок")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("synth", help="сгенерировать синтетические снимки с дефектами")
    p.add_argument("--out", default="data/synth")
    p.add_argument("--n", type=int, default=400)
    p.add_argument("--defect-rate", type=float, default=0.3)
    p.add_argument("--seed", type=int, default=0)

    p = sub.add_parser("calibrate", help="снять эталоны рецепта с годных бутылок")
    p.add_argument("--recipe", required=True)
    p.add_argument("--images", required=True, help="папка только с годными бутылками")
    p.add_argument("--out", help="куда записать рецепт (по умолчанию — показать отчёт)")

    p = sub.add_parser("setup", help="рецепт «по эталону» из снимка годной бутылки")
    p.add_argument("--image", required=True)
    p.add_argument("--bottle", required=True, help="рамка бутылки x,y,w,h (от верха крышки до дна)")
    p.add_argument("--label", help="рамка этикетки x,y,w,h")
    p.add_argument("--diameter", type=float, required=True, help="диаметр бутылки, мм")
    p.add_argument("--cap-diameter", type=float, default=30)
    p.add_argument("--cap-height", type=float, default=18)
    p.add_argument("--sku", default="my-sku")
    p.add_argument("--out", required=True)

    p = sub.add_parser("run", help="инспекция потока снимков")
    p.add_argument("--recipe", required=True)
    p.add_argument("--source", required=True, help="папка со снимками или cam:0")
    p.add_argument("--out", default="out")
    p.add_argument("--shadow", action="store_true", help="режим «тени»: решать и писать, но не сбрасывать")
    p.add_argument("--save-good-every", type=int, default=20)
    p.add_argument("--quiet", action="store_true")

    p = sub.add_parser("evaluate", help="метрики приёмки по разметке")
    p.add_argument("--journal", default="out/journal.csv")
    p.add_argument("--labels", required=True)

    p = sub.add_parser("review", help="дашборд: снимки брака и отметки оператора")
    p.add_argument("--out", default="out")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)

    p = sub.add_parser("simulate", help="симуляция конвейера: энкодер, очередь, сбрасыватель")
    p.add_argument("--journal", help="взять решения из журнала (иначе случайные)")
    p.add_argument("--n", type=int, default=2000)
    p.add_argument("--reject-rate", type=float, default=0.03)
    p.add_argument("--distance-mm", type=float, default=600, help="камера -> сбрасыватель")
    p.add_argument("--window-mm", type=float, default=25, help="допуск совпадения позиции")
    p.add_argument("--slip-mm", type=float, default=2.0, help="СКО проскальзывания бутылки")
    p.add_argument("--speed", type=float, default=250, help="скорость ленты, мм/с")
    p.add_argument("--latency-ms", type=float, default=150, help="время от съёмки до решения")
    p.add_argument("--p-remove", type=float, default=0.0, help="вероятность снять бутылку с ленты")
    p.add_argument("--p-foreign", type=float, default=0.0, help="вероятность подставить чужую")
    p.add_argument("--shadow", action="store_true")
    p.add_argument("--seed", type=int, default=0)

    a = ap.parse_args(argv)

    if a.cmd == "synth":
        out = synth.generate(a.out, a.n, a.defect_rate, a.seed)
        print(f"{a.n} снимков и labels.csv -> {out}")
    elif a.cmd == "calibrate":
        new, report = calibrate(folder_frames(a.images), load_recipe(a.recipe))
        print(report)
        if a.out:
            save_recipe(new, a.out)
            print(f"рецепт -> {a.out}")
    elif a.cmd == "setup":
        import cv2
        from .reference import make_recipe
        box = lambda t: tuple(int(v) for v in t.split(","))
        img = cv2.imread(a.image)
        if img is None:
            raise SystemExit(f"не читается {a.image}")
        recipe, notes = make_recipe(img, box(a.bottle), a.diameter, box(a.label) if a.label else None,
                                    cap_diameter_mm=a.cap_diameter, cap_height_mm=a.cap_height, sku=a.sku)
        save_recipe(recipe, a.out)
        print("\n".join(notes) or "ок", f"\nрецепт -> {a.out}")
    elif a.cmd == "run":
        recipe = load_recipe(a.recipe)
        src = a.source
        frames = camera_frames(int(src[4:]), recipe) if src.startswith("cam:") else folder_frames(src)
        vs = run(frames, recipe, a.out, a.shadow, a.save_good_every,
                 None if a.quiet else print_verdict)
        print(f"итого {len(vs)}, брак {sum(not v.ok for v in vs)}; журнал: {a.out}/journal.csv")
    elif a.cmd == "evaluate":
        report, ok = evaluate(a.journal, a.labels)
        print(report)
        return 0 if ok else 1
    elif a.cmd == "review":
        from .review import serve
        serve(a.out, a.host, a.port)
    elif a.cmd == "simulate":
        if a.journal:
            with open(a.journal, encoding="utf-8") as f:
                rejects = [r["verdict"] == "reject" for r in csv.DictReader(f)]
        else:
            rng = random.Random(a.seed)
            rejects = [rng.random() < a.reject_rate for _ in range(a.n)]
        res = simulate(rejects, distance_mm=a.distance_mm, window_mm=a.window_mm, slip_mm=a.slip_mm,
                       speed_mm_s=a.speed, latency_ms=a.latency_ms, p_remove=a.p_remove,
                       p_foreign=a.p_foreign, shadow=a.shadow, seed=a.seed)
        print(res.report())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
