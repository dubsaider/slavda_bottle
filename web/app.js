// Браузерная оболочка прототипа: Pyodide выполняет тот же пакет bottlecheck, что и CLI.
"use strict";

// ?pyodide=/путь/ — своя копия Pyodide на том же сайте (для сети без доступа к CDN).
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const pyodideParam = new URLSearchParams(location.search).get("pyodide");
const PYODIDE_URL = pyodideParam && /^\/?[\w\-\/.]+\/$/.test(pyodideParam) && !pyodideParam.includes("..") && !pyodideParam.startsWith("//")
  ? pyodideParam : PYODIDE_CDN;
const MODULES = ["__init__", "vision", "inspection", "calibrate", "tracking", "evaluate", "synth", "reference", "web"];
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
