// Браузерная оболочка прототипа: Pyodide выполняет тот же пакет bottlecheck, что и CLI.
"use strict";

// ?pyodide=/путь/ — своя копия Pyodide на том же сайте (для сети без доступа к CDN).
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const pyodideParam = new URLSearchParams(location.search).get("pyodide");
const PYODIDE_URL = pyodideParam && /^\/?[\w\-\/.]+\/$/.test(pyodideParam) && !pyodideParam.includes("..") && !pyodideParam.startsWith("//")
  ? pyodideParam : PYODIDE_CDN;
const MODULES = ["__init__", "vision", "inspection", "calibrate", "tracking", "evaluate", "synth", "web"];
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
      const src = await (await fetch(`bottlecheck/${m}.py`, { cache: "no-cache" })).text();
      py.FS.writeFile(`/home/pyodide/bottlecheck/${m}.py`, src);
    }
    web = py.pyimport("bottlecheck.web");
    ({ reasons: REASONS, defects: DEFECTS } = JSON.parse(web.reasons_json()));
    demoRecipe = await (await fetch("recipes/demo_05.json", { cache: "no-cache" })).text();
    let saved = null;
    try { saved = localStorage.getItem(RECIPE_KEY); } catch (e) { /* приватный режим */ }
    $("rText").value = saved || demoRecipe;
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

function recipeJson() {
  return JSON.stringify(JSON.parse($("rText").value));
}

// ---------- вкладки ----------
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === b.dataset.tab));
    if (b.dataset.tab === "journal") renderJournal();
    if (b.dataset.tab === "metrics") renderMetrics();
    if (b.dataset.tab === "recipe") updateGoodCount();
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
    const f = grab(200);
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

// ---------- рецепт ----------
function updateGoodCount() {
  const n = rows.filter((r) => r.truth === "ok" && r.raw).length;
  $("rGood").textContent = `годных с разметкой: ${n}`;
}
$("rSave").addEventListener("click", () => {
  try {
    const txt = JSON.stringify(JSON.parse($("rText").value), null, 2);
    $("rText").value = txt;
    try { localStorage.setItem(RECIPE_KEY, txt); } catch (e) { /* не критично */ }
    flashReport("Рецепт сохранён в этом браузере.");
  } catch (e) {
    flashReport("Ошибка в JSON: " + e.message);
  }
});
$("rReset").addEventListener("click", () => {
  $("rText").value = demoRecipe;
  try { localStorage.removeItem(RECIPE_KEY); } catch (e) { /* не критично */ }
  flashReport("Возвращён демо-рецепт.");
});
$("rCalib").addEventListener("click", () => {
  const raws = rows.filter((r) => r.truth === "ok" && r.raw).map((r) => r.raw);
  if (raws.length < 5) return flashReport("Нужно хотя бы 5 снимков с разметкой «годная».");
  const res = JSON.parse(web.calibrate_json(JSON.stringify(raws), recipeJson()));
  if (res.error) return flashReport(res.error);
  $("rText").value = JSON.stringify(res.recipe, null, 2);
  try { localStorage.setItem(RECIPE_KEY, $("rText").value); } catch (e) { /* не критично */ }
  flashReport(res.report + "\n\nРецепт обновлён и сохранён.");
});
function flashReport(text) {
  $("rReport").classList.remove("hidden");
  $("rReport").textContent = text;
}

boot();
