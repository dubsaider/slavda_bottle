"""Мини-дашборд на стандартной библиотеке: снимки брака с причиной и отметки оператора.

Отметка «ложная отбраковка» / «пропущен брак» пишется в feedback.csv рядом с журналом —
это сырьё для подстройки порогов и для метрик.
"""
from __future__ import annotations

import csv
import html
import json
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .evaluate import feedback_summary
from .inspection import REASONS

MARKS = {"confirmed": "брак подтверждён", "false_reject": "ложная отбраковка", "missed": "пропущен брак"}


def _rows(out: Path) -> list[dict]:
    with open(out / "journal.csv", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _marks(out: Path) -> dict:
    p = out / "feedback.csv"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return {r["bottle_id"]: r["mark"] for r in csv.DictReader(f)}


def render_page(out: Path, show_all: bool) -> str:
    rows = _rows(out)
    marks = _marks(out)
    rejects = [r for r in rows if r["verdict"] == "reject"]
    by_reason = Counter(x for r in rejects for x in r["reasons"].split(";") if x)
    shown = rows if show_all else rejects
    stats = " · ".join(f"{html.escape(REASONS.get(k, k))}: {v}" for k, v in by_reason.most_common())
    cards = []
    for r in reversed(shown[-300:]):
        bid = html.escape(r["bottle_id"])
        reasons = ", ".join(REASONS.get(x, x) for x in r["reasons"].split(";") if x) or "годно"
        img = f'<img src="/{html.escape(r["snapshot"])}">' if r["snapshot"] else '<div class="noimg">нет снимка</div>'
        options = ["confirmed", "false_reject"] if r["verdict"] == "reject" else ["missed"]
        buttons = "".join(
            f'<button name="mark" value="{m}" class="{"on" if marks.get(r["bottle_id"]) == m else ""}">{MARKS[m]}</button>'
            for m in options)
        meas = html.escape(json.dumps(json.loads(r["measurements"] or "{}"), ensure_ascii=False))
        cards.append(
            f'<div class="card {r["verdict"]}">{img}<div><b>#{bid}</b> {html.escape(r["source"])}'
            f'{" [тень]" if r["shadow"] == "1" else ""}<br><span class="why">{html.escape(reasons)}</span>'
            f'<details><summary>замеры</summary><code>{meas}</code></details>'
            f'<form method="post" action="/mark"><input type="hidden" name="id" value="{bid}">{buttons}</form></div></div>')
    toggle = '<a href="/">только брак</a>' if show_all else '<a href="/?all=1">все снимки</a>'
    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Отбраковка</title>
<style>
body{{font:14px system-ui,sans-serif;margin:16px;background:#f5f5f4;color:#1c1917}}
.card{{display:flex;gap:12px;background:#fff;border-radius:8px;padding:8px;margin:8px 0;border-left:4px solid #16a34a}}
.card.reject{{border-left-color:#dc2626}} img{{height:220px}} .why{{color:#b91c1c;font-weight:600}}
.ok .why{{color:#15803d}} button{{margin:6px 4px 0 0;padding:6px 10px;border:1px solid #a8a29e;border-radius:6px;background:#fff}}
button.on{{background:#1c1917;color:#fff}} code{{font-size:12px;word-break:break-all}} .noimg{{width:100px;color:#78716c}}
</style></head><body>
<h2>Отбраковка: {len(rows)} бутылок, брак {len(rejects)} ({len(rejects) / max(1, len(rows)):.1%})</h2>
<p>{stats}</p><p>{html.escape(feedback_summary(out))}</p><p>{toggle}</p>{"".join(cards)}</body></html>"""


def serve(out_dir, host: str = "127.0.0.1", port: int = 8000) -> None:
    out = Path(out_dir).resolve()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path.startswith("/snapshots/"):
                p = (out / url.path.lstrip("/")).resolve()
                if p.parent != out / "snapshots" or not p.is_file():
                    return self._send(404, b"not found", "text/plain")
                return self._send(200, p.read_bytes(), "image/jpeg")
            show_all = "all" in parse_qs(url.query)
            self._send(200, render_page(out, show_all).encode())

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(n).decode())
            bid, mark = form.get("id", [""])[0], form.get("mark", [""])[0]
            if bid.isdigit() and mark in MARKS:
                p = out / "feedback.csv"
                new = not p.exists()
                with open(p, "a", newline="", encoding="utf-8") as f:
                    w = csv.writer(f)
                    if new:
                        w.writerow(["ts", "bottle_id", "mark"])
                    w.writerow([time.strftime("%Y-%m-%d %H:%M:%S"), bid, mark])
            self.send_response(303)
            self.send_header("Location", self.headers.get("Referer") or "/")
            self.end_headers()

        def log_message(self, *args):
            pass

    print(f"дашборд: http://{host}:{port}/")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
