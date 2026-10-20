"""Слежение за бутылкой от камеры до сбрасывателя и симуляция конвейера.

На линии между камерой и сбрасывателем едут несколько бутылок, поэтому решение
нельзя применять «к следующей бутылке». Трекер ставит каждое решение в очередь
с ожидаемой позицией энкодера, а датчик перед сбрасывателем сверяет, та ли
бутылка приехала. Любое расхождение — тревога и (по умолчанию) сброс бутылки:
неизвестную бутылку лучше выкинуть, чем пропустить брак.
"""
from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field


@dataclass
class Tracked:
    bottle_id: int
    expected_tick: float
    reject: bool


@dataclass
class Decision:
    bottle_id: int | None
    fire: bool
    reason: str  # "reject" | "pass" | "unknown_bottle" | "shadow"


class RejectTracker:
    def __init__(self, distance_ticks: float, window_ticks: float,
                 shadow: bool = False, fail_safe: bool = True):
        self.distance = distance_ticks
        self.window = window_ticks
        self.shadow = shadow
        self.fail_safe = fail_safe
        self.queue: deque[Tracked] = deque()
        self.alarms: list[tuple[float, str, int | None]] = []

    def inspected(self, bottle_id: int, trigger_tick: float, reject: bool) -> None:
        """Решение инспекции. trigger_tick — энкодер в момент съёмки, не в момент решения."""
        self.queue.append(Tracked(bottle_id, trigger_tick + self.distance, reject))

    def _expire(self, tick: float) -> None:
        while self.queue and self.queue[0].expected_tick + self.window < tick:
            lost = self.queue.popleft()
            self.alarms.append((tick, "lost_bottle", lost.bottle_id))

    def at_ejector(self, tick: float) -> Decision:
        """Датчик перед сбрасывателем увидел бутылку."""
        self._expire(tick)
        if not self.queue or abs(self.queue[0].expected_tick - tick) > self.window:
            self.alarms.append((tick, "unknown_bottle", None))
            return Decision(None, self.fail_safe and not self.shadow, "unknown_bottle")
        item = self.queue.popleft()
        if self.shadow:
            return Decision(item.bottle_id, False, "shadow")
        return Decision(item.bottle_id, item.reject, "reject" if item.reject else "pass")


@dataclass
class SimResult:
    total: int = 0
    rejects: int = 0
    ejected_correct: int = 0  # брак сброшен
    missed: int = 0           # брак уехал дальше
    false_ejected: int = 0    # годная сброшена
    removed: int = 0          # сняты с линии между камерой и сбрасывателем
    foreign: int = 0          # поставлены на линию после камеры
    foreign_ejected: int = 0
    alarms: dict = field(default_factory=dict)

    def report(self) -> str:
        good = self.total - self.rejects
        lines = [
            f"бутылок: {self.total}, брак по решению камеры: {self.rejects}",
            f"брак сброшен:     {self.ejected_correct}",
            f"брак пропущен:    {self.missed}",
            f"годных сброшено:  {self.false_ejected}"
            + (f" ({100 * self.false_ejected / good:.2f}% годных)" if good else ""),
            f"снято с линии: {self.removed}, чужих бутылок: {self.foreign} (сброшено {self.foreign_ejected})",
            f"тревоги: {self.alarms or 'нет'}",
        ]
        return "\n".join(lines)


def simulate(rejects: list[bool], *, distance_mm: float = 600, mm_per_tick: float = 0.5,
             gap_mm: tuple[float, float] = (90, 200), slip_mm: float = 2.0,
             window_mm: float = 25, latency_ms: float = 150, speed_mm_s: float = 250,
             p_remove: float = 0.0, p_foreign: float = 0.0, shadow: bool = False,
             seed: int = 0) -> SimResult:
    """Событийная модель конвейера.

    rejects  — решения камеры по порядку бутылок;
    slip_mm  — СКО проскальзывания бутылки относительно ленты на пути до сбрасывателя;
    latency  — время от съёмки до готового решения (решение может опоздать!).
    """
    rng = random.Random(seed)
    tick = lambda mm: mm / mm_per_tick
    events = []  # (tick, порядок, тип, данные)
    pos = 0.0
    for i, rej in enumerate(rejects):
        pos += rng.uniform(*gap_mm)
        cam = tick(pos)
        events.append((cam + tick(latency_ms / 1000 * speed_mm_s), 0, "verdict", (i, cam, rej)))
        if rng.random() < p_remove:
            events.append((cam, 1, "removed", i))
            continue
        arrive = cam + tick(distance_mm + rng.gauss(0, slip_mm))
        events.append((arrive, 1, "eject_sensor", i))
        if rng.random() < p_foreign:
            events.append((arrive + tick(rng.uniform(*gap_mm) / 2), 1, "eject_sensor", None))
    events.sort(key=lambda e: (e[0], e[1]))

    tr = RejectTracker(tick(distance_mm), tick(window_mm), shadow=shadow)
    res = SimResult(total=len(rejects), rejects=sum(rejects))
    for t, _, kind, data in events:
        if kind == "verdict":
            tr.inspected(*data)
        elif kind == "removed":
            res.removed += 1
        else:
            d = tr.at_ejector(t)
            if data is None:
                res.foreign += 1
                res.foreign_ejected += d.fire
            elif rejects[data] and d.fire:
                res.ejected_correct += 1
            elif rejects[data]:
                res.missed += 1
            elif d.fire:
                res.false_ejected += 1
    tr._expire(float("inf"))
    for _, kind, _ in tr.alarms:
        res.alarms[kind] = res.alarms.get(kind, 0) + 1
    return res
