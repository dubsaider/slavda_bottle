// Браузерная оболочка прототипа: Pyodide выполняет тот же пакет bottlecheck, что и CLI.
"use strict";

// ?pyodide=/путь/ — своя копия Pyodide на том же сайте (для сети без доступа к CDN).
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const pyodideParam = new URLSearchParams(location.search).get("pyodide");
const PYODIDE_URL = pyodideParam && /^\/?[\w\-\/.]+\/$/.test(pyodideParam) && !pyodideParam.includes("..") && !pyodideParam.startsWith("//")
  ? pyodideParam : PYODIDE_CDN;
const MODULES = ["__init__", "vision", "inspection", "calibrate", "tracking", "evaluate", "synth", "reference", "simulator", "web"];
const RECIPE_KEY = "bottlecheck.recipe";
const MAX_ROWS = 2000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let web = null;          // модуль bottlecheck.web
let demoRecipe = null;
let REASONS = {};
let DEFECTS = [];
let rows = [];
let nextId = 0;

const TRUTH_LABELS = {
  "": "не размечено", ok: "годная", no_cap: "нет крышки", cap_color: "цвет крышки",
  level_low: "недолив", level_high: "перелив", no_label: "нет этикетки",
  label_skew: "перекос этикетки", label_shift: "смещение этикетки",
};
const MARKS = { confirmed: "брак подтверждён", false_reject: "ложная отбраковка", missed: "пропущен брак" };

// ---------- загрузка ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("не загрузился " + src));
    document.head.appendChild(el);
  });
}

async function boot() {
  try {
    await loadScript(PYODIDE_URL + "pyodide.js");
    const py = await loadPyodide({ indexURL: PYODIDE_URL });
    setStatus("Загрузка OpenCV…");
    await py.loadPackage(["numpy", "opencv-python"]);
    py.FS.mkdirTree("/home/pyodide/bottlecheck");
    for (const m of MODULES) {
      const res = await fetch(`bottlecheck/${m}.py`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`не загрузился bottlecheck/${m}.py (HTTP ${res.status})`);
      const src = await res.text();
      py.FS.writeFile(`/home/pyodide/bottlecheck/${m}.py`, src);
    }
    web = py.pyimport("bottlecheck.web");
    ({ reasons: REASONS, defects: DEFECTS } = JSON.parse(web.reasons_json()));
    demoRecipe = await (await fetch("recipes/demo_05.json", { cache: "no-cache" })).text();
    let saved = null;
    try { saved = localStorage.getItem(RECIPE_KEY); } catch (e) { /* приватный режим */ }
    setRecipe(JSON.parse(saved || demoRecipe), false);
    document.querySelectorAll("button:disabled, input:disabled").forEach((el) => (el.disabled = false));
    $("camShot").disabled = true; // до включения камеры
    setStatus("Готово", "ready");
  } catch (e) {
    console.error(e);
    setStatus("Ошибка загрузки: " + e.message, "error");
  }
}

function setStatus(text, cls = "loading") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + cls;
}

// Рецепт: полная версия (с эталонным снимком) живёт в recipeStr, в редакторе снимок заменён заглушкой.
const IMG_PH = "(эталонный снимок хранится отдельно)";
let recipeStr = "{}";
let refImage = null;

function setRecipe(obj, persist = true) {
  if (obj.reference && obj.reference.image && obj.reference.image !== IMG_PH) refImage = obj.reference.image;
  if (obj.reference && obj.reference.image === IMG_PH) obj.reference.image = refImage;
  recipeStr = JSON.stringify(obj);
  const view = JSON.parse(recipeStr);
  if (view.reference) view.reference.image = IMG_PH;
  $("rText").value = JSON.stringify(view, null, 2);
  if (persist) {
    try { localStorage.setItem(RECIPE_KEY, recipeStr); } catch (e) { /* не критично */ }
  }
  $("demoBanner").classList.toggle("hidden", !String(obj.sku || "").startsWith("demo"));
}

function recipeJson() {
  return recipeStr;
}

// ---------- вкладки ----------
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === b.dataset.tab));
    if (b.dataset.tab === "journal") renderJournal();
    if (b.dataset.tab === "metrics") renderMetrics();
    if (b.dataset.tab === "recipe") updateGoodCount();
    if (b.dataset.tab === "sim") { simRefresh(); simDraw(); }
    if (b.dataset.tab === "sim3d") loadSim3d();
  })
);

for (const [k, v] of Object.entries(TRUTH_LABELS)) {
  const o = document.createElement("option");
  o.value = k;
  o.textContent = v;
  $("truth").appendChild(o);
}

// ---------- журнал ----------
function reasonText(r) {
  return r.reasons.length ? r.reasons.map((x) => REASONS[x] || x).join(", ") : "годно";
}

function addRow(res, source, truth, raw) {
  const shadow = $("shadow").checked;
  const row = {
    id: nextId++, ts: new Date().toLocaleString("ru-RU"), source, truth,
    verdict: res.ok ? "ok" : "reject", reasons: res.reasons, measurements: res.measurements,
    image: res.image, raw, shadow, ejected: !res.ok && !shadow, mark: null,
  };
  rows.push(row);
  if (rows.length > MAX_ROWS) rows.shift();
  $("jcount").textContent = rows.length;
  return row;
}

function renderJournal() {
  const all = $("jAll").checked;
  const rej = rows.filter((r) => r.verdict === "reject");
  const byReason = {};
  rej.forEach((r) => r.reasons.forEach((x) => (byReason[x] = (byReason[x] || 0) + 1)));
  $("jStats").innerHTML =
    stat(rows.length, "бутылок") + stat(rej.length, "брак") +
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => stat(v, REASONS[k] || k)).join("");
  const shown = (all ? rows : rej).slice(-200).reverse();
  $("jList").innerHTML = shown.length ? shown.map(card).join("") : '<p class="hint">Пока пусто.</p>';
}

function stat(v, label) {
  return `<div class="stat"><b>${esc(v)}</b>${esc(label)}</div>`;
}

function card(r) {
  const opts = r.verdict === "reject" ? ["confirmed", "false_reject"] : ["missed"];
  const marks = opts.map((m) =>
    `<button data-id="${r.id}" data-mark="${m}" class="${r.mark === m ? "on" : ""}">${MARKS[m]}</button>`).join("");
  return `<div class="card ${r.verdict}">
    <img src="${r.image}" alt="" loading="lazy">
    <div class="meta"><b>#${r.id}</b> ${esc(r.source)}${r.shadow ? " · тень" : ""}<br>
      <span class="why">${esc(reasonText(r))}</span><br>
      <span class="hint">разметка: ${esc(TRUTH_LABELS[r.truth] || r.truth || "—")}</span>
      <details><summary>замеры</summary><code>${esc(JSON.stringify(r.measurements, null, 1))}</code></details>
      <div class="marks">${marks}</div></div></div>`;
}

$("jList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mark]");
  if (!b) return;
  const r = rows.find((x) => x.id === Number(b.dataset.id));
  r.mark = r.mark === b.dataset.mark ? null : b.dataset.mark;
  renderJournal();
});
$("jAll").addEventListener("change", renderJournal);
$("jClear").addEventListener("click", () => {
  if (rows.length && confirm("Удалить весь журнал?")) {
    rows = [];
    $("jcount").textContent = 0;
    renderJournal();
  }
});
$("jExport").addEventListener("click", () => {
  const head = ["id", "ts", "source", "truth", "verdict", "reasons", "measurements", "shadow", "ejected", "mark"];
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const lines = [head.join(",")].concat(rows.map((r) => [
    r.id, r.ts, r.source, r.truth, r.verdict, r.reasons.join(";"), JSON.stringify(r.measurements),
    r.shadow ? 1 : 0, r.ejected ? 1 : 0, r.mark || ""].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `journal_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
});

// ---------- метрики ----------
function renderMetrics() {
  if (!web) return;
  const rej = rows.filter((r) => r.verdict === "reject").length;
  const m = { confirmed: 0, false_reject: 0, missed: 0 };
  rows.forEach((r) => r.mark && m[r.mark]++);
  const labeled = rows.filter((r) => r.truth).length;
  $("mSummary").innerHTML = stat(rows.length, "бутылок") + stat(rej, "брак по решению") +
    stat(labeled, "с разметкой") + stat(m.confirmed, MARKS.confirmed) +
    stat(m.false_reject, MARKS.false_reject) + stat(m.missed, MARKS.missed) +
    stat(rows.length ? (100 * m.false_reject / rows.length).toFixed(2) + "%" : "—", "ложная отбраковка по отметкам");
  const res = JSON.parse(web.evaluate_json(JSON.stringify(
    rows.map((r) => ({ truth: r.truth, verdict: r.verdict, reasons: r.reasons })))));
  $("mReport").textContent = res.report;
}

// ---------- сигнал «сброса» ----------
let audio = null;
function signal(ok) {
  const f = $("flash");
  const shadow = $("shadow").checked;
  f.className = "flash " + (ok ? "good" : shadow ? "" : "bad");
  requestAnimationFrame(() => setTimeout(() => (f.className = "flash"), 60));
  if (ok || shadow || !$("sound").checked) return;
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.25);
  } catch (e) { /* без звука */ }
}

function showLast(row) {
  const el = $("last");
  el.classList.remove("empty");
  const cls = row.verdict === "ok" ? "ok" : row.shadow ? "shadow" : "bad";
  const title = row.verdict === "ok" ? "ГОДНО" : row.shadow ? "[тень] был бы СБРОС" : "СБРОС";
  el.innerHTML = `<div class="verdict ${cls}">${title}</div>
    <div>${esc(reasonText(row))}</div><img src="${row.image}" alt="">`;
}

// ---------- камера ----------
const video = $("video");
const canvas = $("grab");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let armed = true, emptyFrames = 0, busy = false, timer = null;

function grab(maxSide) {
  const w0 = video.videoWidth || video.naturalWidth || video.width;
  const h0 = video.videoHeight || video.naturalHeight || video.height;
  return grabFrom(video, w0, h0, maxSide);
}

function grabFrom(src, w0, h0, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(src, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function inspectGrab(f, source) {
  const res = JSON.parse(web.inspect_frame(f.data, f.w, f.h, recipeJson()));
  const raw = canvas.toDataURL("image/jpeg", 0.9);
  const row = addRow(res, source, $("truth").value, raw);
  showLast(row);
  signal(res.ok);
  return row;
}

function shoot(source) {
  if (busy || !video.videoWidth) return;
  busy = true;
  try { inspectGrab(grab(720), source); } catch (e) { alert("Ошибка: " + e.message); } finally { busy = false; }
}

function tick() {
  if (!$("auto").checked || busy || !video.videoWidth) return;
  busy = true;
  try {
    const f = grab(720);  // тот же размер, что у снимков: эталон привязан к масштабу кадра
    const p = JSON.parse(web.probe(f.data, f.w, f.h, recipeJson()));
    emptyFrames = p.found ? 0 : emptyFrames + 1;
    if (emptyFrames >= 3) armed = true;
    $("armed").classList.toggle("hidden", !armed);
    if (armed && p.centered) {
      armed = false;
      $("armed").classList.add("hidden");
      busy = false;
      shoot("cam " + new Date().toLocaleTimeString("ru-RU"));
    }
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

$("camStart").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $("camShot").disabled = false;
    $("camStart").disabled = true;
    timer = setInterval(tick, 300);
  } catch (e) {
    alert("Камера недоступна: " + e.message);
  }
});
$("camShot").addEventListener("click", () => shoot("cam " + new Date().toLocaleTimeString("ru-RU")));

$("upload").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    const bmp = await createImageBitmap(file);
    inspectGrab(grabFrom(bmp, bmp.width, bmp.height, 720), file.name);
    await new Promise((r) => setTimeout(r, 0));
  }
  e.target.value = "";
});

// ---------- синтетика ----------
async function runSynth(n, rate, seed) {
  const bar = $("sProgress");
  bar.classList.remove("hidden");
  $("sRun").disabled = $("sGood").disabled = true;
  const recipe = recipeJson();
  try {
    for (let i = 0; i < n; i += 10) {
      const batch = JSON.parse(web.synth_batch(i, Math.min(10, n - i), rate, seed, recipe));
      batch.forEach((r) => addRow(r, r.source, r.truth, r.raw));
      bar.firstElementChild.style.width = (100 * Math.min(n, i + 10) / n) + "%";
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    $("sRun").disabled = $("sGood").disabled = false;
    setTimeout(() => bar.classList.add("hidden"), 800);
  }
}
$("sRun").addEventListener("click", () => runSynth(+$("sN").value, +$("sRate").value, +$("sSeed").value));
$("sGood").addEventListener("click", () => runSynth(60, 0, 1));

// ---------- конвейер ----------
const PRESETS = {
  normal: { cRem: 0, cFor: 0, cLat: 150, cSlip: 2 },
  hands: { cRem: 0.01, cFor: 0.005, cLat: 150, cSlip: 2 },
  late: { cRem: 0, cFor: 0, cLat: 3000, cSlip: 2 },
  slip: { cRem: 0, cFor: 0, cLat: 150, cSlip: 15 },
};
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
  Object.entries(PRESETS[b.dataset.preset]).forEach(([k, v]) => ($(k).value = v));
  runConveyor();
}));

function runConveyor() {
  if (!web) return;
  let rejects;
  if ($("cJournal").checked && rows.length) {
    rejects = rows.map((r) => r.verdict === "reject");
  } else {
    const n = +$("cN").value, p = +$("cRate").value;
    rejects = Array.from({ length: n }, () => Math.random() < p);
  }
  const params = {
    distance_mm: +$("cDist").value, window_mm: +$("cWin").value, slip_mm: +$("cSlip").value,
    speed_mm_s: +$("cSpeed").value, latency_ms: +$("cLat").value,
    p_remove: +$("cRem").value, p_foreign: +$("cFor").value, shadow: $("shadow").checked,
    seed: Math.floor(Math.random() * 1e6),
  };
  const res = JSON.parse(web.simulate_json(JSON.stringify(rejects), JSON.stringify(params)));
  const travel = params.latency_ms / 1000 * params.speed_mm_s;
  $("cReport").textContent = res.report +
    `\n\nза время решения лента проходит ${travel.toFixed(0)} мм (до сбрасывателя ${params.distance_mm} мм)` +
    (travel >= params.distance_mm ? " — решение опаздывает, сбрасыватель нужно отодвинуть" : "");
}
$("cRun").addEventListener("click", runConveyor);

// ---------- симулятор: виртуальный конвейер по эталону ----------
// Кадры готовятся заранее (Pyodide работает в основном потоке и подвесил бы анимацию),
// дальше лента, очередь решений и сбрасыватель считаются здесь, на тех же кадрах.
const SIM_OUT = {
  caught: "брак сброшен", missed: "брак пропущен камерой", lost: "брак не сброшен: решение не доехало",
  false_cam: "годная сброшена: камера ошиблась", false_track: "годная сброшена: не та бутылка", good: "годная прошла",
};
const sim = { frames: [], info: null, world: null, playing: false, last: 0 };

class SimTracker {  // то же, что tracking.RejectTracker
  constructor(distance, window, shadow) {
    Object.assign(this, { distance, window, shadow, queue: [], alarms: {} });
  }
  alarm(kind) { this.alarms[kind] = (this.alarms[kind] || 0) + 1; }
  inspected(id, camS, reject) { this.queue.push({ id, expected: camS + this.distance, reject }); }
  expire(S) {
    while (this.queue.length && this.queue[0].expected + this.window < S) { this.queue.shift(); this.alarm("lost_bottle"); }
  }
  atEjector(S) {
    this.expire(S);
    if (!this.queue.length || Math.abs(this.queue[0].expected - S) > this.window) {
      this.alarm("unknown_bottle");
      return { id: null, fire: !this.shadow, reason: "unknown_bottle" };
    }
    const it = this.queue.shift();
    if (this.shadow) return { id: it.id, fire: false, reason: "shadow" };
    return { id: it.id, fire: it.reject, reason: it.reject ? "reject" : "pass" };
  }
}

function simRefresh() {
  if (!web) return;
  sim.info = JSON.parse(web.sim_info(recipeJson()));
  const r = JSON.parse(recipeStr);
  $("simRecipe").textContent = `Эталон: ${r.sku || "—"} · ` + (sim.info.reference
    ? `по снимку, ⌀${sim.info.diameter_mm} мм, высота ${sim.info.height_mm} мм`
    : "демо-рецепт: синтетическая бутылка вместо снимка");
  const prev = new Set([...document.querySelectorAll("#simDefects input:checked")].map((x) => x.value));
  const had = document.querySelectorAll("#simDefects input").length;
  $("simDefects").innerHTML = '<span class="hint">Виды брака:</span>' + sim.info.defects.map((d) =>
    `<label class="check"><input type="checkbox" value="${d}" ${!had || prev.has(d) ? "checked" : ""}> ${esc(TRUTH_LABELS[d] || d)}</label>`).join("");
  const off = ["level_low", "no_cap", "no_label"].filter((d) => !sim.info.defects.includes(d));
  $("simNote").textContent = off.includes("level_low") && sim.info.reference
    ? "Уровень в рецепте выключен, поэтому недолив и перелив не рисуются и не проверяются." : "";
}

$("simWater").addEventListener("click", async () => {
  const cur = JSON.parse(recipeStr);
  if (cur.mode === "reference" && cur.sku !== "вода 1,5 л" &&
      !confirm("Заменить текущий рецепт эталоном «вода 1,5 л»? Свой рецепт можно заранее скопировать во вкладке «Рецепт».")) return;
  const res = await fetch("recipes/water_15.json", { cache: "no-cache" });
  if (!res.ok) return alert("не загрузился recipes/water_15.json");
  setRecipe(await res.json());
  simRefresh();
});

function simParams() {
  const g = $("simGap").value.split(/[–—-]/).map(Number).filter((v) => v > 0);
  const d = sim.info ? sim.info.diameter_mm : 65;
  const lo = Math.max(d + 5, g[0] || 150), hi = Math.max(lo, g[1] || g[0] || 150);
  return {
    speed: Math.max(1, +$("simSpeed").value), gap: [lo, hi], dist: Math.max(50, +$("simDist").value),
    win: +$("simWin").value, lat: +$("simLat").value / 1000, slip: +$("simSlip").value, shadow: $("shadow").checked,
  };
}

$("simPrep").addEventListener("click", async () => {
  simRefresh();
  const defects = [...document.querySelectorAll("#simDefects input:checked")].map((x) => x.value);
  const n = Math.max(1, Math.min(500, +$("simN").value));
  const params = {
    seed: +$("simSeed").value, defect_rate: +$("simRate").value, defects, severity: $("simSev").value,
    jitter: +$("simJit").value, exposure_ms: +$("simExp").value, speed_mm_s: simParams().speed,
  };
  simStop();
  sim.frames = [];
  const bar = $("simProgress");
  bar.classList.remove("hidden");
  $("simPrep").disabled = $("simPlay").disabled = $("simRestart").disabled = true;
  const t0 = performance.now();
  try {
    for (let i = 0; i < n; i++) {
      const [r] = JSON.parse(web.sim_batch(i, 1, JSON.stringify(params), recipeJson()));
      r.img = new Image();
      r.img.src = r.thumb;
      sim.frames.push(r);
      if ($("simJournal").checked) addRow(r, r.source, r.truth, null);
      bar.firstElementChild.style.width = (100 * (i + 1) / n) + "%";
      await new Promise((res) => setTimeout(res, 0));
    }
  } catch (e) {
    console.error(e);
    alert("Ошибка: " + e.message);
  } finally {
    $("simPrep").disabled = false;
    setTimeout(() => bar.classList.add("hidden"), 600);
  }
  const ms = (performance.now() - t0) / Math.max(1, sim.frames.length);
  const blur = params.exposure_ms / 1000 * params.speed_mm_s;
  $("simPrepInfo").textContent = `Готово ${sim.frames.length} кадров, ${ms.toFixed(0)} мс на кадр в браузере. ` +
    `Смаз за выдержку: ${blur.toFixed(1)} мм при ${params.speed_mm_s} мм/с` +
    (blur > 2 ? " — заметный, нужна короткая выдержка или импульсная подсветка." : ".");
  $("simPlay").disabled = $("simRestart").disabled = !sim.frames.length;
  simReset();
});

function simReset() {
  const p = simParams();
  sim.world = {
    p, t: 0, S: 0, next: 0, nextS: 0, bottles: [], pending: [], flash: null,
    tracker: new SimTracker(p.dist, p.win, p.shadow), out: {}, byClass: {}, errors: [], bin: 0, done: false,
  };
  $("simErrors").innerHTML = '<p class="hint">Пока ошибок нет.</p>';
  $("simLast").className = "last empty";
  $("simLast").textContent = "Кадры готовы, нажмите «Пуск».";
  simStats();
  simDraw();
}

function simStop() {
  sim.playing = false;
  $("simPlay").textContent = "▶ Пуск";
}

$("simPlay").addEventListener("click", () => {
  if (!sim.world || sim.world.done) simReset();
  sim.playing = !sim.playing;
  $("simPlay").textContent = sim.playing ? "⏸ Пауза" : "▶ Пуск";
  sim.last = performance.now();
  if (sim.playing) requestAnimationFrame(simLoop);
});
$("simRestart").addEventListener("click", () => { simStop(); simReset(); });

const SIM_BEFORE = 350, SIM_AFTER = 350;  // мм ленты до камеры и после сбрасывателя

function simLoop(now) {
  if (!sim.playing) return;
  const dt = Math.min(0.1, (now - sim.last) / 1000) * +$("simRate2").value;
  sim.last = now;
  const steps = Math.ceil(dt / 0.002);
  for (let i = 0; i < steps && !sim.world.done; i++) simStep(dt / steps);
  simDraw();
  if (sim.world.done) {
    simStop();
    simStats();
    return;
  }
  requestAnimationFrame(simLoop);
}

function simBaseX(w, b) { return -SIM_BEFORE + (w.S - b.spawnS); }
function simX(w, b) {  // проскальзывание набегает между камерой и сбрасывателем
  const x = simBaseX(w, b);
  return x + b.slip * Math.min(1, Math.max(0, x / w.p.dist));
}

function simStep(dt) {
  const w = sim.world, p = w.p;
  if (w.next < sim.frames.length && w.S >= w.nextS) {
    w.bottles.push({ i: w.next, f: sim.frames[w.next], spawnS: w.S, slip: gauss() * p.slip, cam: false, ej: false, drop: 0 });
    w.next++;
    w.nextS = w.S + p.gap[0] + Math.random() * (p.gap[1] - p.gap[0]);
  }
  const before = w.bottles.map((b) => simX(w, b));
  w.t += dt;
  w.S += p.speed * dt;
  w.pending = w.pending.filter((v) => {
    if (v.at > w.t) return true;
    w.tracker.inspected(v.id, v.camS, v.reject);
    return false;
  });
  w.bottles.forEach((b, k) => {
    const x = simX(w, b);
    if (!b.cam && x >= 0) {
      b.cam = true;
      const camS = w.S - (x - 0);  // энкодер в момент съёмки
      w.pending.push({ at: w.t + p.lat, id: b.i, camS, reject: !b.f.ok });
      w.flash = { t: w.t, ok: b.f.ok };
      simShowLast(b.f);
    }
    if (b.cam && !b.ej && x >= p.dist && before[k] < p.dist + 1e-9) {
      b.ej = true;
      b.decision = w.tracker.atEjector(w.S - (x - p.dist));
      simOutcome(b);
    }
    if (b.decision && b.decision.fire) b.drop += dt;
  });
  w.bottles = w.bottles.filter((b) => {
    const gone = b.drop > 0.6 || simX(w, b) > p.dist + SIM_AFTER + 100;
    if (gone && b.decision && b.decision.fire) w.bin++;
    return !gone;
  });
  if (w.next >= sim.frames.length && !w.bottles.length) {
    w.tracker.expire(Infinity);
    w.done = true;
  }
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function simOutcome(b) {
  const w = sim.world, f = b.f, fire = b.decision.fire, bad = f.truth !== "ok";
  const kind = bad ? (fire ? "caught" : f.ok ? "missed" : "lost") : !fire ? "good" : f.ok ? "false_track" : "false_cam";
  b.kind = kind;
  w.out[kind] = (w.out[kind] || 0) + 1;
  const c = (w.byClass[f.truth] = w.byClass[f.truth] || { n: 0, cam: 0, fired: 0 });
  c.n++;
  c.cam += !f.ok;
  c.fired += fire;
  if (!["caught", "good"].includes(kind)) {
    w.errors.unshift({ f, kind, reason: b.decision.reason });
    $("simErrors").innerHTML = w.errors.slice(0, 24).map((e) => `<div class="card reject">
      <img src="${e.f.image}" alt="">
      <div class="meta"><b>${esc(SIM_OUT[e.kind])}</b><br>
        <span class="hint">на самом деле: ${esc(TRUTH_LABELS[e.f.truth] || e.f.truth)}</span><br>
        <span class="why">камера: ${esc(reasonText(e.f))}</span>
        ${e.reason === "unknown_bottle" ? '<br><span class="hint">датчик у сбрасывателя увидел бутылку, которой нет в очереди</span>' : ""}
        <details><summary>замеры</summary><code>${esc(JSON.stringify(e.f.measurements, null, 1))}</code></details></div></div>`).join("");
  }
  simStats();
}

function simShowLast(f) {
  const el = $("simLast");
  el.className = "last";
  el.innerHTML = `<div class="verdict ${f.ok ? "ok" : "bad"}">${f.ok ? "ГОДНО" : "БРАК"}</div>
    <div>${esc(reasonText(f))} <span class="hint">· на самом деле: ${esc(TRUTH_LABELS[f.truth] || f.truth)}</span></div>
    <img src="${f.image}" alt="">`;
}

function simStats() {
  const w = sim.world;
  if (!w) return;
  const o = w.out, done = Object.values(o).reduce((a, b) => a + b, 0);
  const alarms = Object.entries(w.tracker.alarms).map(([k, v]) =>
    `${k === "lost_bottle" ? "решение без бутылки" : "бутылка без решения"}: ${v}`).join(", ");
  $("simStats").innerHTML = stat(`${done} / ${sim.frames.length}`, "прошло сбрасыватель") +
    Object.entries(SIM_OUT).map(([k, v]) => `<div class="stat ${["caught", "good"].includes(k) ? "" : (o[k] ? "warn" : "")}"><b>${o[k] || 0}</b>${esc(v)}</div>`).join("") +
    stat(alarms || "нет", "тревоги трекинга");
  const rows = Object.entries(w.byClass).sort((a, b) => (a[0] === "ok" ? -1 : b[0] === "ok" ? 1 : a[0].localeCompare(b[0])));
  $("simTable").innerHTML = rows.length ? "<tr><th>Класс</th><th>Бутылок</th><th>Камера: брак</th><th>Сброшено</th></tr>" +
    rows.map(([k, c]) => `<tr class="${(k === "ok" ? c.fired : c.n - c.fired) ? "bad" : ""}"><td>${esc(TRUTH_LABELS[k] || k)}</td><td>${c.n}</td><td>${c.cam}</td><td>${c.fired}</td></tr>`).join("")
    : "";
}

function simDraw() {
  const cv = $("simCanvas"), w = sim.world;
  if (!w || !cv.offsetParent) return;
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const p = w.p, info = sim.info || { diameter_mm: 65, height_mm: 205 };
  const cssW = cv.clientWidth, dpr = window.devicePixelRatio || 1;
  const x0 = -SIM_BEFORE, range = p.dist + SIM_BEFORE + SIM_AFTER;
  const k = cssW / range;
  // бутылки рисуются не выше 170 px: на широком экране в масштабе ленты они огромные
  const bs = Math.min(1, 170 / (info.height_mm * k));
  const bh = info.height_mm * k * bs, top = 34, beltY = top + bh, cssH = Math.round(beltY + 90);
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + "px";
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const X = (mm) => (mm - x0) * k;
  g.font = "12px system-ui";
  // лента с бегущей разметкой
  g.fillStyle = col("--line");
  g.fillRect(0, beltY, cssW, 10);
  g.fillStyle = col("--muted");
  for (let m = -((w.S % 50) + 50); m < range + 50; m += 50) g.fillRect(m * k, beltY + 4, 2, 2);
  // камера
  const fl = w.flash && w.t - w.flash.t < 0.25 ? w.flash : null;
  if (fl) {
    g.fillStyle = fl.ok ? "rgba(22,163,74,.25)" : "rgba(220,38,38,.3)";
    g.fillRect(X(0) - 0.8 * bh * 0.3, top, 1.6 * bh * 0.3, bh);
  }
  g.strokeStyle = col("--accent");
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(X(0), 14); g.lineTo(X(0), beltY); g.stroke();
  g.setLineDash([]);
  g.fillStyle = col("--accent");
  g.fillText("камера", X(0) - 20, 12);
  // окно совпадения и сбрасыватель
  g.fillStyle = "rgba(127,127,127,.15)";
  g.fillRect(X(p.dist - p.win), top, 2 * p.win * k, bh);
  g.fillStyle = col("--bad");
  g.fillText("сбрасыватель", X(p.dist) - 36, 12);
  g.fillRect(X(p.dist) - 1, 16, 2, beltY - 16);
  // очередь решений: где по энкодеру должна быть каждая бутылка из очереди
  for (const q of w.tracker.queue) {
    const xq = p.dist - (q.expected - w.S);
    g.fillStyle = q.reject ? col("--bad") : col("--ok");
    g.beginPath(); g.moveTo(X(xq), beltY + 12); g.lineTo(X(xq) - 5, beltY + 20); g.lineTo(X(xq) + 5, beltY + 20); g.fill();
  }
  // бункер
  const binX = X(p.dist + info.diameter_mm * 0.2), binW = Math.max(40, info.diameter_mm * 2 * k);
  g.strokeStyle = col("--bad");
  g.strokeRect(binX, beltY + 34, binW, 40);
  g.fillStyle = col("--bad");
  g.fillText(`брак: ${w.bin}`, binX + 4, beltY + 58);
  // бутылки
  for (const b of w.bottles) {
    const x = simX(w, b), img = b.f.img;
    const h = bh, iw = img.naturalWidth ? h * img.naturalWidth / img.naturalHeight : info.diameter_mm * k * bs;
    const drop = b.drop > 0 ? Math.min(1, b.drop / 0.5) : 0;
    g.save();
    g.globalAlpha = 1 - 0.6 * drop;
    g.translate(X(x) + drop * 30, beltY - h / 2 + drop * (h * 0.6 + 40));
    g.rotate(drop * 1.2);
    if (img.complete && img.naturalWidth) g.drawImage(img, -iw / 2, -h / 2, iw, h);
    else { g.fillStyle = col("--muted"); g.fillRect(-iw / 2, -h / 2, iw, h); }
    g.restore();
    if (b.cam && !drop) {
      g.fillStyle = b.f.ok ? col("--ok") : col("--bad");
      g.beginPath(); g.arc(X(x), top - 8, 5, 0, 2 * Math.PI); g.fill();
    }
  }
  if (w.done) {
    g.fillStyle = col("--ink");
    g.fillText("Готово. «Заново на тех же кадрах» — повторить с другими настройками ленты.", 8, cssH - 6);
  }
}
window.addEventListener("resize", simDraw);

// ---------- 3D-линия (модуль грузится при первом открытии вкладки) ----------
const VER = new URL(document.currentScript.src).searchParams.get("v") || "";
let sim3d = null;
async function loadSim3d() {
  if (sim3d) return;
  try {
    sim3d = await import("./sim3d.js" + (VER ? "?v=" + VER : ""));
    sim3d.mount();
  } catch (e) {
    console.error(e);
    sim3d = null;
    $("s3status").textContent = "Не загрузилась 3D-сцена: " + e.message;
  }
}

// ---------- рецепт ----------
function updateGoodCount() {
  const n = rows.filter((r) => r.truth === "ok" && r.raw).length;
  $("rGood").textContent = `годных с разметкой: ${n}`;
}
$("rSave").addEventListener("click", () => {
  try {
    setRecipe(JSON.parse($("rText").value));
    flashReport("Рецепт сохранён в этом браузере.");
  } catch (e) {
    flashReport("Ошибка в JSON: " + e.message);
  }
});
$("rReset").addEventListener("click", () => {
  setRecipe(JSON.parse(demoRecipe), false);
  try { localStorage.removeItem(RECIPE_KEY); } catch (e) { /* не критично */ }
  flashReport("Возвращён демо-рецепт.");
});
$("rCalib").addEventListener("click", () => {
  const raws = rows.filter((r) => r.truth === "ok" && r.raw).map((r) => r.raw);
  if (raws.length < 5) return flashReport("Нужно хотя бы 5 снимков с разметкой «годная».");
  const res = JSON.parse(web.calibrate_json(JSON.stringify(raws), recipeJson()));
  if (res.error) return flashReport(res.error);
  setRecipe(res.recipe);
  flashReport(res.report + "\n\nРецепт обновлён и сохранён.");
});
function flashReport(text) {
  $("rReport").classList.remove("hidden");
  $("rReport").textContent = text;
}

// ---------- настройка по эталону ----------
const su = { raw: null, img: null, bottle: null, label: null, step: "bottle", drag: null };
const suCanvas = $("suCanvas");
const suCtx = suCanvas.getContext("2d");

function suLoad(raw) {
  const img = new Image();
  img.onload = () => {
    Object.assign(su, { raw, img, bottle: null, label: null, step: "bottle" });
    suCanvas.width = img.naturalWidth;
    suCanvas.height = img.naturalHeight;
    $("suNotes").classList.add("hidden");
    $("suCheck").classList.add("hidden");
    suStep("bottle");
  };
  img.src = raw;
}

function suStep(step) {
  su.step = step;
  $("suStepBottle").classList.toggle("on", step === "bottle");
  $("suStepLabel").classList.toggle("on", step === "label");
  $("suHint").textContent = !su.img ? "Сначала выберите снимок."
    : step === "bottle" ? "Обведите бутылку целиком: от верха крышки до дна, от края до края."
    : "Обведите этикетку по её краям (или нажмите «без этикетки»).";
  $("suMake").disabled = !su.bottle;
  suDraw();
}

function suDraw() {
  if (!su.img) return;
  suCtx.drawImage(su.img, 0, 0);
  const lw = Math.max(2, suCanvas.width / 300);
  for (const [r, color, name] of [[su.bottle, "#ef4444", "бутылка"], [su.label, "#3b82f6", "этикетка"]]) {
    if (!r) continue;
    suCtx.strokeStyle = color;
    suCtx.lineWidth = lw;
    suCtx.strokeRect(r[0], r[1], r[2], r[3]);
    suCtx.fillStyle = color;
    suCtx.font = `${Math.round(lw * 7)}px system-ui`;
    suCtx.fillText(name, r[0], Math.max(lw * 7, r[1] - lw * 2));
  }
}

function suPoint(e) {
  const b = suCanvas.getBoundingClientRect();
  return [(e.clientX - b.left) * suCanvas.width / b.width, (e.clientY - b.top) * suCanvas.height / b.height];
}
suCanvas.addEventListener("pointerdown", (e) => {
  if (!su.img) return;
  suCanvas.setPointerCapture(e.pointerId);
  su.drag = suPoint(e);
});
suCanvas.addEventListener("pointermove", (e) => {
  if (!su.drag) return;
  const [x, y] = suPoint(e);
  const [x0, y0] = su.drag;
  su[su.step] = [Math.round(Math.min(x, x0)), Math.round(Math.min(y, y0)), Math.round(Math.abs(x - x0)), Math.round(Math.abs(y - y0))];
  suDraw();
});
suCanvas.addEventListener("pointerup", () => {
  if (!su.drag) return;
  su.drag = null;
  const r = su[su.step];
  if (!r || r[2] < 8 || r[3] < 8) { su[su.step] = null; suDraw(); return; }
  suStep(su.step === "bottle" ? "label" : "label");
});
$("suStepBottle").addEventListener("click", () => suStep("bottle"));
$("suStepLabel").addEventListener("click", () => suStep("label"));
$("suNoLabel").addEventListener("click", () => { su.label = null; $("suLabel").checked = false; suStep("label"); });

$("suLast").addEventListener("click", () => {
  const last = [...rows].reverse().find((r) => r.raw && !r.source.startsWith("synth"));
  if (!last) return alert("Нет снимков: сделайте снимок во вкладке «Камера» или загрузите фото.");
  suLoad(last.raw);
});
$("suUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bmp = await createImageBitmap(file);
  grabFrom(bmp, bmp.width, bmp.height, 720);  // тот же размер, что у проверяемых кадров
  suLoad(canvas.toDataURL("image/jpeg", 0.92));
  e.target.value = "";
});

$("suMake").addEventListener("click", () => {
  if (!su.bottle) return;
  const params = {
    bottle: su.bottle, label: $("suLabel").checked ? su.label : null,
    diameter_mm: +$("suD").value, cap_diameter_mm: +$("suCapD").value, cap_height_mm: +$("suCapH").value,
    sku: $("suSku").value,
    checks: { cap: { enabled: $("suCap").checked }, label: { enabled: $("suLabel").checked }, level: { enabled: $("suLevel").checked } },
  };
  const res = JSON.parse(web.make_reference_json(su.raw, JSON.stringify(params)));
  const notes = $("suNotes");
  notes.classList.remove("hidden");
  if (res.error) { notes.textContent = res.error; return; }
  setRecipe(res.recipe);
  const verdict = res.check.ok ? "Эталонный снимок проходит проверку." : "Эталонный снимок НЕ проходит: " + reasonText(res.check);
  notes.textContent = ["Рецепт создан и сохранён.", verdict, ...res.notes,
    "", "Дальше: в «Разметке» выберите «годная», снимите 5–20 годных бутылок (переставляя их на метку),",
    "затем «Рецепт» → «Калибровать по годным». После этого можно снимать брак."].join("\n");
  $("suCheck").src = res.check.image;
  $("suCheck").classList.remove("hidden");
});

document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () =>
  document.querySelector(`#tabs button[data-tab="${b.dataset.goto}"]`).click()));

boot();
