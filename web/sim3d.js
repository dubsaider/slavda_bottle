// 3D-линия: лента, бутылки, станция камеры с подсветкой, датчик и пневмосбрасыватель.
// Виртуальная камера снимает каждую бутылку, кадр проверяет тот же Python-код
// (в фоновом потоке), решение едет по очереди энкодера к сбрасывателю.
// Общие функции и константы (SimTracker, SIM_OUT, TRUTH_LABELS, stat, esc, …) — из app.js.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const MM = 0.001;                 // сцена в метрах, параметры в мм
const FRAME_W = 400, FRAME_H = 720;
const BEFORE = 900, AFTER = 700;  // мм ленты до камеры и после сбрасывателя
const TRIGGER = 160;              // датчик запуска камеры, мм до её оси
const DEFECTS3D = ["no_cap", "cap_color", "level_low", "level_high", "no_label", "label_skew", "label_shift", "fallen"];
const LABELS3D = { ...TRUTH_LABELS, fallen: "упавшая бутылка" };
const WRONG_CAPS = [0x2563eb, 0xdc2626, 0x16a34a, 0xeab308, 0x111111];
// Расстановка камер вокруг бутылки (азимут, °; 0 — сбоку, со стороны сбрасывателя).
// 90° и 270° — это вдоль ленты, туда камеру не поставить.
const LAYOUTS = { 1: [0], 2: [0, 180], 3: [0, 120, 240], 4: [45, 135, 225, 315] };
const SPAN = 140;                 // развёртка печати со снимка, °: края цилиндра на фото затенены
const PRINTS = [0, SPAN];         // середины двух копий печати на этикетке, °
const SEVERITY = { clear: [1.5, 3.0], edge: [1.1, 1.6] };

const $ = (id) => document.getElementById(id);
const el = {};
let three = null;    // сцена, рендерер, геометрия
let worker = null, workerReady = null, callId = 0;
const calls = new Map();
let src = null;      // эталонный снимок, из которого сделана 3D-бутылка
let recipe3d = null, refKey = "";
let run = null;      // состояние прогона

// ---------- фоновый Python ----------
function startWorker() {
  if (workerReady) return workerReady;
  const v = new URL(document.querySelector('script[src^="app.js"]').src).searchParams.get("v") || "";
  worker = new Worker("sim3d_worker.js" + (v ? "?v=" + v : ""));
  workerReady = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if ("ready" in m) return m.ready ? resolve() : reject(new Error(m.error));
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (!c) return;
      if (m.error) c.reject(new Error(m.error));
      else c.resolve({ result: JSON.parse(m.result), ms: m.ms });
    };
  });
  worker.postMessage({ init: { pyodide: new URL(PYODIDE_URL, location.href).href, modules: MODULES, base: location.href } });
  return workerReady;
}

function py(fn, ...args) {
  const id = ++callId;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}

// ---------- бутылка по эталонному снимку ----------
async function loadSource() {
  let r = JSON.parse(recipeStr);
  if (r.mode !== "reference" || !r.label) {
    r = await (await fetch("recipes/water_15.json", { cache: "no-cache" })).json();
  }
  const img = new Image();
  img.src = r.reference.image;
  await img.decode();
  const [x, y, w, h] = r.reference.rect;
  const D = r.bottle.diameter_mm, H = r.bottle.height_mm, ppm = w / D;
  const row = (mm) => y + h - mm * ppm;
  const cap = r.cap;
  const capH = (cap.to_mm - cap.from_mm) / 0.76, capD = cap.width_mm / 0.85;
  // цвет крышки и развёртка этикетки — прямо со снимка
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const cx = x + w / 2;
  const cy0 = Math.round(row(H - 0.2 * capH)), cy1 = Math.round(row(H - 0.8 * capH));
  const cd = g.getImageData(Math.round(cx - capD * ppm * 0.3), cy0, Math.max(1, Math.round(capD * ppm * 0.6)), Math.max(1, cy1 - cy0)).data;
  const rgb = [0, 0, 0];
  for (let i = 0; i < cd.length; i += 4) for (let k = 0; k < 3; k++) rgb[k] += cd[i + k];
  const capColor = new THREE.Color(rgb[0] / (cd.length / 4) / 255, rgb[1] / (cd.length / 4) / 255, rgb[2] / (cd.length / 4) / 255);
  const lt = Math.round(row(r.label.top_mm)), lb = Math.round(row(r.label.bottom_mm));
  // На снимке цилиндр виден в проекции: столбец x = cx + R·sin(θ). Разворачиваем ±SPAN/2,
  // печать повторяем с двух сторон бутылки, между ними полоса склейки.
  const front = 300, total = Math.round(front * 360 / SPAN);
  const lab = document.createElement("canvas");
  lab.width = total;
  lab.height = lb - lt;
  const lg = lab.getContext("2d");
  for (let u = 0; u < front; u++) {
    const th = (-SPAN / 2 + SPAN * (u + 0.5) / front) * Math.PI / 180;
    const sx = cx + (w / 2) * Math.sin(th);
    for (const off of [0, front]) lg.drawImage(c, sx, lt, 1, lb - lt, u + off, 0, 1, lb - lt);
  }
  // склейка — фон этикетки: медиана каждой строки (полосы сохраняются, текст — нет)
  const fr = lg.getImageData(0, 0, front, lb - lt).data, seam = lg.createImageData(1, lb - lt);
  for (let y = 0; y < lb - lt; y++) {
    for (let k = 0; k < 3; k++) {
      const vals = [];
      for (let u = 0; u < front; u++) vals.push(fr[(y * front + u) * 4 + k]);
      vals.sort((a, b) => a - b);
      seam.data[y * 4 + k] = vals[vals.length >> 1];
    }
    seam.data[y * 4 + 3] = 255;
  }
  for (let u = 2 * front; u < total; u++) lg.putImageData(seam, u, 0);
  return {
    sku: r.sku, D, H, capH, capD, capColor, label: { top: r.label.top_mm, bottom: r.label.bottom_mm, canvas: lab },
    tol: { angle: r.label.max_angle_deg || 3, shift: r.label.shift_tol_mm || 4, level: (r.level && r.level.tol_mm) || 4 },
  };
}

function bottleProfile(s) {
  // Профиль ПЭТ-бутылки (мм от дна): лепестковое дно, корпус, плечи с рёбрами, горло.
  const R = s.D / 2, neck = s.capD / 2 - 1.5, H = s.H, top = H - s.capH;
  const pts = [[0, 0], [R * 0.55, 0], [R * 0.82, 2], [R * 0.96, 7], [R, 14]];
  const sh0 = Math.max(s.label.top + 8, H * 0.6), sh1 = top - 14;
  for (let y = 16; y <= sh0; y += 4) pts.push([R * (1 - 0.025 * (Math.sin(y / 9) > 0.9)), y]);
  for (let i = 1; i <= 40; i++) {
    const t = i / 40, y = sh0 + (sh1 - sh0) * t;
    const r = neck + (R - neck) * (0.5 + 0.5 * Math.cos(Math.PI * t)) * (1 - 0.06 * Math.max(0, Math.sin(t * 5 * Math.PI)));
    pts.push([r, y]);
  }
  pts.push([neck + 3, top - 10], [neck + 3, top - 8], [neck, top - 7], [neck, top + 1], [0, top + 1]);
  return pts;
}

function lathe(pts, segs = 48) {
  return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r * MM, y * MM)), segs);
}

function buildAssets(s) {
  const prof = bottleProfile(s);
  const level0 = s.H - s.capH - 24;
  const waterCache = new Map();
  const water = (level) => {
    const key = Math.round(level);
    if (!waterCache.has(key)) {
      const pts = [];
      for (const [r, y] of prof) {
        if (y > key) {
          const prev = pts[pts.length - 1];
          pts.push([prev ? prev[0] : r, key]);
          break;
        }
        pts.push([Math.max(0, r - 1.2), Math.max(0.5, y)]);
      }
      pts.push([0, key]);
      waterCache.set(key, lathe(pts, 40));
    }
    return waterCache.get(key);
  };
  const tex = new THREE.CanvasTexture(s.label.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const labelH = s.label.top - s.label.bottom;
  const ribs = document.createElement("canvas");
  ribs.width = 256;
  ribs.height = 8;
  const rg = ribs.getContext("2d");
  rg.fillStyle = "#fff";
  rg.fillRect(0, 0, 256, 8);
  rg.fillStyle = "#b8b8b8";
  for (let i = 0; i < 256; i += 4) rg.fillRect(i, 0, 1, 8);
  const ribTex = new THREE.CanvasTexture(ribs);
  ribTex.colorSpace = THREE.SRGBColorSpace;
  const capMat = new Map();
  const radiusAt = (y) => {
    for (let i = 1; i < prof.length; i++) {
      const [r0, y0] = prof[i - 1], [r1, y1] = prof[i];
      if (y1 >= y && y0 <= y) return r0 + (r1 - r0) * (y - y0) / Math.max(1e-6, y1 - y0);
    }
    return s.D / 2;
  };
  return {
    level0, radiusAt,
    // мениск: на просвет граница воды видна тёмной линией
    meniscusMat: new THREE.MeshBasicMaterial({ color: 0x3f4a54, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    body: lathe(prof),
    bodyMat: new THREE.MeshStandardMaterial({ color: 0xe6eef2, transparent: true, opacity: 0.22, roughness: 0.08, side: THREE.DoubleSide, depthWrite: false }),
    water,
    waterMat: new THREE.MeshStandardMaterial({ color: 0xa9cbd9, transparent: true, opacity: 0.32, roughness: 0.05, depthWrite: false }),
    label: new THREE.CylinderGeometry((s.D / 2 + 0.4) * MM, (s.D / 2 + 0.4) * MM, labelH * MM, 64, 1, true, -SPAN / 2 * Math.PI / 180),
    labelMat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide }),
    labelH,
    cap: new THREE.CylinderGeometry(s.capD / 2 * MM, s.capD / 2 * MM, s.capH * MM, 48),
    capMat: (color) => {
      const k = new THREE.Color(color).getHexString();
      if (!capMat.has(k)) capMat.set(k, new THREE.MeshStandardMaterial({ color, map: ribTex, roughness: 0.5 }));
      return capMat.get(k);
    },
  };
}

function makeBottle(t, defect, rng, exact = false) {
  // exact — без естественного разброса уровня и этикетки (эталонная бутылка)
  const s = t.src, a = t.assets, jit = exact ? 0 : 1;
  const g = new THREE.Group();
  const [lo, hi] = SEVERITY[t.sev || "clear"];
  const sev = lo + (hi - lo) * rng();
  const sign = rng() < 0.5 ? -1 : 1;
  const lvl = defect === "level_low" ? a.level0 - s.tol.level * sev
    : defect === "level_high" ? a.level0 + Math.min(s.tol.level * sev, s.capH + 18) : a.level0 + jit * gauss() * s.tol.level / 5;
  g.add(new THREE.Mesh(a.water(lvl), a.waterMat));
  const mr = (a.radiusAt(lvl) - 0.8) * MM;
  const men = new THREE.Mesh(new THREE.CylinderGeometry(mr, mr, 1.6 * MM, 40, 1, true), a.meniscusMat);
  men.position.y = lvl * MM;
  g.add(men);
  const body = new THREE.Mesh(a.body, a.bodyMat);
  body.renderOrder = 2;
  g.add(body);
  if (defect !== "no_label") {
    const lab = new THREE.Mesh(a.label, a.labelMat);
    const shift = defect === "label_shift" ? sign * s.tol.shift * sev : jit * gauss() * s.tol.shift / 5;
    const ang = defect === "label_skew" ? sign * s.tol.angle * sev : jit * gauss() * s.tol.angle / 5;
    lab.position.y = (s.label.bottom + a.labelH / 2 + shift) * MM;
    lab.rotation.z = ang * Math.PI / 180;
    g.add(lab);
  }
  if (defect !== "no_cap") {
    const color = defect === "cap_color" ? WRONG_CAPS[Math.floor(rng() * WRONG_CAPS.length)] : s.capColor;
    const cap = new THREE.Mesh(a.cap, a.capMat(color));
    cap.position.y = (s.H - s.capH / 2) * MM;
    g.add(cap);
  }
  return g;
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

// ---------- сцена ----------
function buildScene() {
  const host = el.canvas;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b2f33);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 1.5, 1.2);
  scene.add(sun);
  const view = new THREE.PerspectiveCamera(40, 1, 0.01, 20);
  const controls = new OrbitControls(view, renderer.domElement);
  controls.enableDamping = true;
  const t = { renderer, scene, view, controls, statics: new THREE.Group() };
  scene.add(t.statics);
  const rt = new THREE.WebGLRenderTarget(FRAME_W, FRAME_H, { colorSpace: THREE.SRGBColorSpace });
  t.rt = rt;
  t.frameCanvas = document.createElement("canvas");
  t.frameCanvas.width = FRAME_W;
  t.frameCanvas.height = FRAME_H;
  new ResizeObserver(() => resize(t)).observe(host);
  return t;
}

function resize(t) {
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  if (!w || !h) return;
  t.renderer.setSize(w, h, false);
  t.view.aspect = w / h;
  t.view.updateProjectionMatrix();
}

function buildLine(t, p) {
  const s = t.src, st = t.statics;
  st.clear();
  const len = (BEFORE + p.dist + AFTER) * MM, x0 = -BEFORE * MM, beltW = (s.D + 40) * MM;
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  // лента с бегущей разметкой
  const bc = document.createElement("canvas");
  bc.width = 64;
  bc.height = 8;
  const bg = bc.getContext("2d");
  bg.fillStyle = "#3a3d40";
  bg.fillRect(0, 0, 64, 8);
  bg.fillStyle = "#55595d";
  bg.fillRect(0, 0, 6, 8);
  t.beltTex = new THREE.CanvasTexture(bc);
  t.beltTex.wrapS = THREE.RepeatWrapping;
  t.beltTex.repeat.set(len / 0.05, 1);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, beltW), [mat(0x2f3235), mat(0x2f3235), new THREE.MeshStandardMaterial({ map: t.beltTex, roughness: 0.9 }), mat(0x2f3235), mat(0x2f3235), mat(0x2f3235)]);
  belt.position.set(x0 + len / 2, -0.01, 0);
  st.add(belt);
  for (const z of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.012, 0.006), mat(0xb0b5ba, { metalness: 0.6, roughness: 0.3 }));
    rail.position.set(x0 + len / 2, 0.03, z * (s.D / 2 + 6) * MM);
    st.add(rail);
  }
  for (let x = x0 + 0.1; x < x0 + len; x += 0.6) {
    for (const z of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.75, 0.03), mat(0x6b7075, { metalness: 0.5 }));
      leg.position.set(x, -0.395, z * beltW * 0.45);
      st.add(leg);
    }
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), mat(0x1f2225));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.77;
  st.add(floor);
  // Станции камер: камера, макет и напротив неё панель (подсветка сзади или тёмный фон).
  // Панель отодвинута за ленту, чтобы бутылки проезжали между ней и камерой.
  const H = s.H * MM;
  const dist = (H * 1.25 / 2) / Math.tan(12.5 * Math.PI / 180);
  t.stations = LAYOUTS[p.cams].map((deg) => {
    const a = deg * Math.PI / 180, dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const cam = new THREE.PerspectiveCamera(25, FRAME_W / FRAME_H, 0.05, 5);
    cam.position.set(dir.x * dist, H / 2, dir.z * dist);
    cam.lookAt(0, H / 2, 0);
    cam.updateMatrixWorld();
    const hw = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.12), mat(0x1d4ed8, { metalness: 0.3 }));
    body.position.z = 0.07;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.04, 24), mat(0x111111));
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.005;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(H * 0.62, dist, 4, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    cone.rotation.x = Math.PI / 2;  // вершина конуса — у камеры
    cone.rotation.y = Math.PI / 4;
    cone.position.z = -dist / 2;
    hw.add(body, lens, cone);
    hw.position.copy(cam.position);
    hw.rotation.y = a;
    const rz = Math.abs(Math.cos(a)) > 0.2 ? (beltW / 2 + 0.03) / Math.abs(Math.cos(a)) : 0.3;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.42, H * 1.6),
      p.backlight ? new THREE.MeshBasicMaterial({ color: 0xf4f6f8 }) : mat(0x34383c));
    panel.position.set(-dir.x * Math.max(rz, (s.D / 2 + 60) * MM), H * 0.7, -dir.z * Math.max(rz, (s.D / 2 + 60) * MM));
    panel.rotation.y = a;
    st.add(hw, panel);
    return { deg, cam, hw, cone, panel };
  });
  t.inspectCam = t.stations[0].cam;
  // Фотодатчики. Датчик запуска стоит на TRIGGER мм раньше камеры (иначе он сам попал бы
  // в кадр), снимок делается по энкодеру, когда бутылка доехала до оси камеры.
  t.beams = [-TRIGGER, p.dist].map((x) => {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, beltW + 0.04), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    beam.position.set(x * MM, 0.04, 0);
    st.add(beam);
    for (const z of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.07, 0.015), mat(0xfacc15));
      post.position.set(x * MM, 0.035, z * (beltW / 2 + 0.02));
      st.add(post);
    }
    return beam;
  });
  // пневмосбрасыватель (со стороны камеры) и лоток брака с другой стороны
  const ex = p.dist * MM;
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 24), mat(0x9ca3af, { metalness: 0.7, roughness: 0.3 }));
  cyl.rotation.x = Math.PI / 2;
  cyl.position.set(ex, 0.06, beltW / 2 + 0.11);
  st.add(cyl);
  t.piston = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.012), mat(0xdc2626));
  t.pistonHome = beltW / 2 + 0.03;
  t.piston.position.set(ex, 0.06, t.pistonHome);
  st.add(t.piston);
  const chute = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.01, 0.3), mat(0x7f1d1d));
  chute.rotation.x = 0.5;
  chute.position.set(ex, -0.08, -(beltW / 2 + 0.14));
  st.add(chute);
  const bin = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.25, 0.3), mat(0x991b1b, { transparent: true, opacity: 0.85 }));
  bin.position.set(ex, -0.5, -(beltW / 2 + 0.3));
  st.add(bin);
  setView(t, "overview", p);
}

function setView(t, name, p) {
  const H = t.src.H * MM, ex = p.dist * MM;
  const v = {
    overview: [[ex * 0.3, H * 2.2, 1.35], [ex * 0.45, H * 0.3, 0]],
    camera: [[t.stations[0].cam.position.x * 0.75, H * 0.55, t.stations[0].cam.position.z * 0.75], [0, H * 0.5, 0]],
    ejector: [[ex + 0.35, H * 1.3, 0.55], [ex, H * 0.2, -0.05]],
  }[name];
  t.view.position.set(...v[0]);
  t.controls.target.set(...v[1]);
  t.controls.update();
}

// ---------- кадр виртуальной камеры ----------
function capture(t, k = 0) {
  // Камера k снимает так, будто у каждой станции свой закрытый тоннель:
  // чужие камеры и панели в кадр не попадают, соседние бутылки — попадают.
  const { renderer, scene, rt, frameCanvas } = t;
  t.stations.forEach((st, i) => { st.hw.visible = false; st.panel.visible = i === k; });
  renderer.setRenderTarget(rt);
  renderer.render(scene, t.stations[k].cam);
  const px = new Uint8Array(FRAME_W * FRAME_H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, FRAME_W, FRAME_H, px);
  renderer.setRenderTarget(null);
  t.stations.forEach((st) => { st.hw.visible = true; st.panel.visible = true; });
  const g = frameCanvas.getContext("2d");
  const img = g.createImageData(FRAME_W, FRAME_H);
  const row = FRAME_W * 4;
  for (let y = 0; y < FRAME_H; y++) img.data.set(px.subarray((FRAME_H - 1 - y) * row, (FRAME_H - y) * row), y * row);
  g.putImageData(img, 0, 0);
  return frameCanvas.toDataURL("image/jpeg", 0.92);
}

function projectRect(t, pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y, z] of pts) {
    const v = new THREE.Vector3(x, y, z).project(t.inspectCam);
    const px = (v.x + 1) / 2 * FRAME_W, py = (1 - v.y) / 2 * FRAME_H;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
}

// ---------- эталон 3D-камеры: как наладчик на линии ----------
async function makeReference(t, p) {
  const s = t.src, R = s.D / 2 * MM;
  status("Снимаю эталон: годная бутылка этикеткой к камере…");
  const ref = makeBottle(t, "ok", Math.random, true);
  ref.rotation.y = t.stations[0].deg * Math.PI / 180;
  t.scene.add(ref);
  const url = capture(t, 0);
  t.scene.remove(ref);
  // рамки в кадре камеры 0: контур бутылки в плоскости, перпендикулярной лучу зрения
  const a = t.stations[0].deg * Math.PI / 180, ux = Math.cos(a), uz = -Math.sin(a);
  const side = (k, y) => [k * R * ux, y, k * R * uz];
  const bottle = projectRect(t, [side(-1, 0), side(1, 0), side(-1, s.H * MM), side(1, s.H * MM)]);
  const label = projectRect(t, [side(-1, s.label.bottom * MM), side(1, s.label.top * MM)]);
  const params = {
    bottle, label, diameter_mm: s.D, cap_diameter_mm: s.capD, cap_height_mm: s.capH, sku: "3D: " + s.sku,
    checks: { cap: { enabled: true }, label: { enabled: true }, level: { enabled: true } },
  };
  const { result: made } = await py("make_reference_json", url, JSON.stringify(params));
  if (made.error) throw new Error(made.error);
  status("Калибрую по 12 годным бутылкам с тем же разбросом, что на ленте…");
  // В калибровку идёт кадр той камеры, которая лучше видит этикетку, — как и в решении.
  const urls = [];
  for (let i = 0; i < 12; i++) {
    const b = makeBottle(t, "ok", Math.random);
    b.rotation.y = randomRotation(p);
    b.position.z = gauss() * 1.5 * MM;
    t.scene.add(b);
    urls.push(capture(t, labelCamera(t, b.rotation.y)));
    t.scene.remove(b);
  }
  const { result: cal } = await py("calibrate_json", JSON.stringify(urls), JSON.stringify(made.recipe));
  if (cal.error) throw new Error(cal.error);
  recipe3d = cal.recipe;
  el.ref.className = "last";
  el.ref.innerHTML = `<div>${made.notes.map(esc).join("<br>") || "Эталон снят."}</div>
    <pre class="small">${esc(cal.report)}</pre><img src="${made.check.image}" alt="">`;
}

function randomRotation(p) {
  return (Math.random() * 2 - 1) * p.rot * Math.PI / 180;
}

function labelCamera(t, rotation) {
  // камера, ближе всего к которой повёрнута одна из копий печати
  const wrap = (d) => Math.abs(((d % 360) + 540) % 360 - 180);
  const deg = rotation * 180 / Math.PI;
  let best = 0, bestD = 1e9;
  t.stations.forEach((st, i) => PRINTS.forEach((c) => {
    const d = wrap(st.deg - (deg + c));
    if (d < bestD) { bestD = d; best = i; }
  }));
  return best;
}

// ---------- прогон ----------
function params() {
  const g = el.gap.value.split(/[–—-]/).map(Number).filter((v) => v > 0);
  const D = three && three.src ? three.src.D : 88;
  const lo = Math.max(D + 10, g[0] || 160), hi = Math.max(lo, g[1] || g[0] || 160);
  return {
    speed: Math.max(10, +el.speed.value), gap: [lo, hi], rate: +el.rate.value, rot: Math.max(0, +el.rot.value),
    backlight: el.backlight.checked, dist: Math.max(300, +el.dist.value), win: +el.win.value, slip: +el.slip.value,
    lat: Math.max(0, +el.lat.value) / 1000, shadow: $("shadow").checked,
    cams: Math.min(4, Math.max(1, +el.cams.value || 1)), sev: el.sev.value,
    defects: [...document.querySelectorAll("#s3defects input:checked")].map((x) => x.value),
  };
}

async function ensureReady(p) {
  status("Загрузка Python и OpenCV в фоновом потоке…");
  await startWorker();
  if (!three) {
    three = buildScene();
    resize(three);
    requestAnimationFrame(loop);
  }
  if (!three.src) {
    three.src = await loadSource();
    three.assets = buildAssets(three.src);
  }
  three.sev = p.sev;
  const key = JSON.stringify([p.rot, p.backlight, p.dist, p.cams]);
  if (!recipe3d || refKey !== key) {
    buildLine(three, p);
    await makeReference(three, p);
    refKey = key;
  }
}

function stopRun() {
  if (run) run.bottles.forEach((b) => three.scene.remove(b.g));
  run = null;
  el.play.textContent = "▶ Пуск";
}

async function start() {
  const p = params();
  el.play.disabled = true;
  try {
    await ensureReady(p);
    run = {
      p, t: 0, S: 0, nextS: 0, n: 0, bottles: [], tracker: new SimTracker(p.dist, p.win, p.shadow),
      out: {}, byClass: {}, errors: [], inflight: 0, ms: [], piston: 0, bin: 0,
    };
    el.errors.innerHTML = '<p class="hint">Пока ошибок нет.</p>';
    el.play.textContent = "⏸ Пауза";
    run.playing = true;
    status("Линия работает.");
    renderStats();
  } catch (e) {
    console.error(e);
    status("Ошибка: " + e.message);
  } finally {
    el.play.disabled = false;
  }
}

function status(text) { el.status.textContent = text; }

function pickDefect(p) {
  const list = p.defects;
  return list.length && Math.random() < p.rate ? list[Math.floor(Math.random() * list.length)] : "ok";
}

function createBottle(p, defect) {
  const g = makeBottle(three, defect === "fallen" ? "ok" : defect, Math.random);
  g.rotation.y = randomRotation(p);
  if (defect === "fallen") {
    g.rotation.set(0, 0, Math.PI / 2);
    g.position.y = three.src.D / 2 * MM;
  }
  g.position.z = gauss() * 1.5 * MM;
  three.scene.add(g);
  return g;
}

function spawn(r) {
  const defect = pickDefect(r.p);
  const g = createBottle(r.p, defect);
  r.bottles.push({ id: r.n++, defect, g, spawnS: r.S, slip: gauss() * r.p.slip, cam: false, ej: false, push: 0 });
}

// ---------- прогон без ленты: только камеры и решение ----------
async function batch(p, n, progress) {
  // Бутылка ставится к камерам, с годными соседями на среднем шаге (их видно
  // в кадре наклонных камер), снимается всеми камерами; проверки идут очередью в фоне.
  const pitch = (p.gap[0] + p.gap[1]) / 2 * MM;
  const jobs = [];
  let done = 0;
  for (let i = 0; i < n; i++) {
    const defect = pickDefect(p);
    const g = createBottle(p, defect);
    if (defect === "fallen") g.position.x = three.src.H / 2 * MM;
    const nb = [-1, 1].map((k) => { const x = createBottle(p, "ok"); x.position.x = k * pitch; return x; });
    const urls = three.stations.map((_, k) => capture(three, k));
    [g, ...nb].forEach((x) => three.scene.remove(x));
    jobs.push(py("inspect_multi", JSON.stringify(urls), JSON.stringify(recipe3d)).then(({ result }) => {
      progress(++done, n);
      return { truth: defect, result };
    }));
    if (i % 4 === 3) await new Promise((res) => setTimeout(res, 0));
  }
  return Promise.all(jobs);
}

function rates(rows) {
  const bad = rows.filter((r) => r.truth !== "ok"), good = rows.filter((r) => r.truth === "ok");
  return {
    missed: bad.length ? bad.filter((r) => r.result.ok).length / bad.length : 0,
    false: good.length ? good.filter((r) => !r.result.ok).length / good.length : 0,
    bad: bad.length, good: good.length,
  };
}

const pct = (v) => (100 * v).toFixed(v > 0 && v < 0.1 ? 1 : 0) + "%";

async function runMap() {
  const list = (v) => v.split(/[,; ]+/).map(Number).filter((x) => Number.isFinite(x));
  const rots = list(el.mapRot.value), cams = list(el.mapCams.value).filter((c) => LAYOUTS[c]);
  const n = Math.max(6, +el.mapN.value || 30);
  if (!rots.length || !cams.length) return;
  el.map.disabled = true;
  stopRun();
  const cell = (r, c) => `m_${r}_${c}`.replace(/\W/g, "_");
  el.mapTable.innerHTML = "<tr><th>Поворот ±° \\ камер</th>" + cams.map((c) => `<th>${c}</th>`).join("") + "</tr>" +
    rots.map((r) => `<tr><td>±${r}°</td>` + cams.map((c) => `<td id="${cell(r, c)}" class="mcell">…</td>`).join("") + "</tr>").join("");
  const t0 = performance.now();
  let k = 0;
  try {
    for (const r of rots) {
      for (const c of cams) {
        const p = { ...params(), rot: r, cams: c, rate: 0.5 };
        refKey = "";
        await ensureReady(p);
        const rows = await batch(p, n, (d, total) => status(`Карта: поворот ±${r}°, камер ${c}: ${d}/${total}`));
        const m = rates(rows);
        const td = document.getElementById(cell(r, c));
        const worst = Math.max(m.missed, m.false);
        td.className = "mcell " + (worst === 0 ? "good" : worst < 0.05 ? "warn" : "bad");
        td.innerHTML = `пропуск ${pct(m.missed)}<br>ложн. ${pct(m.false)}`;
        k++;
        const left = (performance.now() - t0) / k * (rots.length * cams.length - k) / 1000;
        status(`Карта: готово ${k} из ${rots.length * cams.length}, осталось ≈ ${Math.ceil(left / 60)} мин`);
      }
    }
    status("Карта готова. Каждая клетка — " + n + " бутылок, половина с браком; лента не участвует, только камеры и решение.");
  } catch (e) {
    console.error(e);
    status("Ошибка: " + e.message);
  } finally {
    refKey = "";  // следующий пуск снимет эталон под текущие настройки
    el.map.disabled = false;
  }
}

// ---------- выбор порога: пропуск против ложного сброса ----------
let tRows = null;

async function collectTradeoff() {
  el.tCollect.disabled = true;
  stopRun();
  try {
    const p = { ...params(), rate: 0.5 };
    await ensureReady(p);
    const n = Math.max(20, +el.tN.value || 150);
    const rows = await batch(p, n, (d, total) => status(`Замеры для выбора порога: ${d}/${total}`));
    tRows = rows.map((r) => ({ truth: r.truth, cams: r.result.measurements }));
    status(`Собрано ${n} бутылок при текущих настройках.`);
    await updateTradeoff();
  } catch (e) {
    console.error(e);
    status("Ошибка: " + e.message);
  } finally {
    el.tCollect.disabled = false;
  }
}

async function updateTradeoff() {
  if (!tRows) return;
  const prm = { prevalence: Math.max(0, +el.tPrev.value) / 100, cost_false: +el.tCostF.value, cost_miss: +el.tCostM.value };
  const { result } = await py("tradeoff_json", JSON.stringify(tRows), JSON.stringify(recipe3d), JSON.stringify(prm));
  el.tApply.disabled = false;
  el.tApply.dataset.s = result.best;
  el.tApply.textContent = `Применить строгость ×${result.best} к рецепту 3D`;
  el.tTable.innerHTML = "<tr><th>Допуски ×</th><th>Пропуск брака</th><th>Ложный сброс</th><th>Потери на 1000 бутылок</th></tr>" +
    result.points.map((q) => `<tr class="${q.s === result.best ? "best" : ""}"><td>${q.s}${q.s === 1 ? " (как сейчас)" : ""}</td><td>${pct(q.missed)}</td><td>${pct(q.false)}</td><td>${Math.round(q.cost).toLocaleString("ru-RU")} ₽</td></tr>`).join("");
  plotTradeoff(result);
  const b = result.points.find((q) => q.s === result.best);
  el.tNote.textContent = `При доле брака на линии ${(prm.prevalence * 100).toFixed(1)}% выгоднее всего допуски ×${result.best}: ` +
    `пропуск ${pct(b.missed)}, ложный сброс ${pct(b.false)}. Выборка — ${tRows.length} бутылок, ` +
    `поэтому доли меньше ${(100 / Math.max(1, b.bad)).toFixed(0)}% пропуска и ${(100 / Math.max(1, b.good)).toFixed(0)}% ложных сбросов она не различает.`;
}

function plotTradeoff(res) {
  const cv = el.tPlot, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 260;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.height = H + "px";
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement), col = (n) => css.getPropertyValue(n).trim();
  const m = { l: 48, r: 12, t: 12, b: 36 };
  const maxX = Math.max(0.05, ...res.points.map((q) => q.false)), maxY = Math.max(0.05, ...res.points.map((q) => q.missed));
  const X = (v) => m.l + v / maxX * (W - m.l - m.r), Y = (v) => H - m.b - v / maxY * (H - m.t - m.b);
  g.strokeStyle = col("--line");
  g.fillStyle = col("--muted");
  g.font = "12px system-ui";
  g.beginPath(); g.moveTo(m.l, m.t); g.lineTo(m.l, H - m.b); g.lineTo(W - m.r, H - m.b); g.stroke();
  g.fillText("ложный сброс годных →", W - 160, H - 8);
  g.save(); g.translate(14, H - m.b); g.rotate(-Math.PI / 2); g.fillText("пропуск брака →", 0, 0); g.restore();
  g.fillText("0", m.l - 12, H - m.b + 14);
  g.fillText(pct(maxX), W - m.r - 30, H - m.b + 14);
  g.fillText(pct(maxY), 6, m.t + 10);
  g.strokeStyle = col("--accent");
  g.beginPath();
  res.points.forEach((q, i) => (i ? g.lineTo(X(q.false), Y(q.missed)) : g.moveTo(X(q.false), Y(q.missed))));
  g.stroke();
  // точки с одинаковым итогом подписываем одной меткой «×a–b»
  const groups = [];
  for (const q of res.points) {
    const last = groups[groups.length - 1];
    if (last && Math.hypot(X(q.false) - X(last[0].false), Y(q.missed) - Y(last[0].missed)) < 8) last.push(q);
    else groups.push([q]);
  }
  for (const grp of groups) {
    const q = grp[0], best = grp.some((x) => x.s === res.best);
    g.fillStyle = best ? col("--ok") : grp.some((x) => x.s === 1) ? col("--ink") : col("--accent");
    g.beginPath(); g.arc(X(q.false), Y(q.missed), best ? 6 : 4, 0, 2 * Math.PI); g.fill();
    const lab = "×" + q.s + (grp.length > 1 ? "–" + grp[grp.length - 1].s : "");
    g.fillText(lab, Math.min(X(q.false) + 6, W - m.r - g.measureText(lab).width), Y(q.missed) - 6);
  }
}

function bx(r, b) {
  const x = -BEFORE + (r.S - b.spawnS);
  return x + b.slip * Math.min(1, Math.max(0, x / r.p.dist));
}

function step(r, dt) {
  const p = r.p;
  if (r.S >= r.nextS) {
    spawn(r);
    r.nextS = r.S + p.gap[0] + Math.random() * (p.gap[1] - p.gap[0]);
  }
  r.t += dt;
  r.S += p.speed * dt;
  for (const b of r.bottles) {
    const x = bx(r, b);
    // упавшая лежит вдоль ленты: дно впереди, середина — в точке x
    if (!b.push) b.g.position.x = (b.defect === "fallen" ? x + three.src.H / 2 : x) * MM;
    if (!b.cam && x >= 0) {
      b.cam = true;
      b.camS = r.S - x;
      shoot(r, b);
    }
    if (b.cam && !b.ej && x >= p.dist) {
      b.ej = true;
      b.decision = r.tracker.atEjector(r.S - (x - p.dist));
      if (b.decision.fire) r.piston = 0.25;
      outcome(r, b);
    }
    if (b.decision && b.decision.fire) {
      b.push += dt;
      const k = Math.min(1, b.push / 0.15);
      b.g.position.z = -k * (three.src.D + 50) * MM - Math.max(0, b.push - 0.15) * 0.6;
      b.g.position.y = -3 * Math.max(0, b.push - 0.15) ** 2;
    }
  }
  r.bottles = r.bottles.filter((b) => {
    const gone = b.push > 0.8 || bx(r, b) > p.dist + AFTER;
    if (gone) {
      three.scene.remove(b.g);
      if (b.push > 0.8) r.bin++;
    }
    return !gone;
  });
  // решения, которые фоновый поток уже вернул, встают в очередь по энкодеру
  for (const b of r.bottles.concat(r.done || [])) {
    if (b.verdict && !b.queued && r.t >= b.readyAt) {
      b.queued = true;
      r.tracker.inspected(b.id, b.camS, !b.verdict.ok);
    }
  }
  r.done = (r.done || []).filter((b) => !b.queued);
  r.piston = Math.max(0, r.piston - dt);
}

function shoot(r, b) {
  const urls = three.stations.map((_, k) => capture(three, k));
  const t0 = r.t;
  r.inflight++;
  b.flash = 0.2;
  py("inspect_multi", JSON.stringify(urls), JSON.stringify(recipe3d)).then(({ result, ms }) => {
    r.inflight--;
    r.ms.push(ms);
    if (r.ms.length > 30) r.ms.shift();
    b.verdict = result;
    b.readyAt = Math.max(r.t, t0 + r.p.lat);
    b.decideMs = (r.t - t0) * 1000;
    if (!r.bottles.includes(b)) (r.done = r.done || []).push(b);
    showLast(b);
  }).catch((e) => {
    r.inflight--;
    console.error(e);
    status("Ошибка проверки: " + e.message);
  });
}

function outcome(r, b) {
  const fire = b.decision.fire, bad = b.defect !== "ok";
  const camBad = b.verdict ? !b.verdict.ok : null;
  const kind = bad ? (fire ? "caught" : camBad === false ? "missed" : "lost")
    : !fire ? "good" : camBad ? "false_cam" : "false_track";
  r.out[kind] = (r.out[kind] || 0) + 1;
  const c = (r.byClass[b.defect] = r.byClass[b.defect] || { n: 0, cam: 0, fired: 0 });
  c.n++;
  c.cam += camBad === true;
  c.fired += fire;
  if (!["caught", "good"].includes(kind)) {
    r.errors.unshift({ b, kind });
    el.errors.innerHTML = r.errors.slice(0, 24).map(({ b, kind }) => `<div class="card reject">
      ${b.verdict ? `<img src="${b.verdict.image}" alt="">` : ""}
      <div class="meta"><b>${esc(SIM_OUT[kind])}</b><br>
        <span class="hint">на самом деле: ${esc(LABELS3D[b.defect] || b.defect)}</span><br>
        <span class="why">камера: ${b.verdict ? esc(reasonText(b.verdict)) : "решение не успело"}</span>
        ${b.decision.reason === "unknown_bottle" ? '<br><span class="hint">датчик у сбрасывателя увидел бутылку, которой нет в очереди — сброс на всякий случай</span>' : ""}
        ${b.decideMs ? `<br><span class="hint">решение через ${b.decideMs.toFixed(0)} мс</span>` : ""}
        ${b.verdict ? `<details><summary>замеры</summary><code>${esc(JSON.stringify(b.verdict.measurements, null, 1))}</code></details>` : ""}</div></div>`).join("");
  }
  renderStats();
}

function showLast(b) {
  const v = b.verdict;
  el.inset.innerHTML = `<div class="verdict ${v.ok ? "ok" : "bad"}">${v.ok ? "ГОДНО" : "БРАК"}</div>
    <div class="small">${esc(reasonText(v))}<br><span class="hint">на самом деле: ${esc(LABELS3D[b.defect] || b.defect)} · ${b.decideMs.toFixed(0)} мс</span></div>
    <img src="${v.image}" alt="">`;
}

function renderStats() {
  const r = run;
  if (!r) return;
  const o = r.out, done = Object.values(o).reduce((a, b) => a + b, 0);
  const avg = r.ms.length ? r.ms.reduce((a, b) => a + b, 0) / r.ms.length : 0;
  const travel = avg / 1000 * r.p.speed;
  const alarms = Object.entries(r.tracker.alarms).map(([k, v]) =>
    `${k === "lost_bottle" ? "решение без бутылки" : "бутылка без решения"}: ${v}`).join(", ");
  el.stats.innerHTML = stat(done, "прошло сбрасыватель") +
    Object.entries(SIM_OUT).map(([k, v]) => `<div class="stat ${["caught", "good"].includes(k) || !o[k] ? "" : "warn"}"><b>${o[k] || 0}</b>${esc(v)}</div>`).join("") +
    stat(alarms || "нет", "тревоги трекинга") +
    stat(avg ? `${avg.toFixed(0)} мс` : "—", `проверка кадра (лента проходит ${travel.toFixed(0)} мм)`);
  const rows = Object.entries(r.byClass).sort((a, b) => (a[0] === "ok" ? -1 : b[0] === "ok" ? 1 : a[0].localeCompare(b[0])));
  el.table.innerHTML = rows.length ? "<tr><th>Класс</th><th>Бутылок</th><th>Камера: брак</th><th>Сброшено</th></tr>" +
    rows.map(([k, c]) => `<tr class="${(k === "ok" ? c.fired : c.n - c.fired) ? "bad" : ""}"><td>${esc(LABELS3D[k] || k)}</td><td>${c.n}</td><td>${c.cam}</td><td>${c.fired}</td></tr>`).join("") : "";
}

let last = 0, hudT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const t = three;
  const dt = Math.min(0.05, (now - last) / 1000 || 0) * (+el.speedup.value || 1);
  last = now;
  if (!el.section.classList.contains("on")) return;
  if (run && run.playing) {
    const n = Math.ceil(dt / 0.004);
    for (let i = 0; i < n; i++) step(run, dt / n);
    t.beltTex.offset.x = -(run.S * MM) / 0.05;
    t.piston.position.z = t.pistonHome - (run.piston > 0 ? Math.min(1, (0.25 - run.piston) / 0.06) : 0) * (t.src.D + 30) * MM;
    if ((hudT += dt) > 0.5) { hudT = 0; renderStats(); el.hud.textContent = `в проверке: ${run.inflight} · в очереди к сбрасывателю: ${run.tracker.queue.length} · в бункере: ${run.bin}`; }
    for (const b of run.bottles) if (b.flash > 0) b.flash -= dt;
    t.beams[0].material.color.set(run.bottles.some((b) => b.flash > 0) ? 0x22c55e : 0xef4444);
  }
  t.controls.update();
  t.renderer.render(t.scene, t.view);
}

// ---------- интерфейс ----------
export function mount() {
  if (el.section) return;
  Object.assign(el, {
    section: $("sim3d"), canvas: $("s3canvas"), status: $("s3status"), hud: $("s3hud"), inset: $("s3inset"),
    stats: $("s3stats"), table: $("s3table"), errors: $("s3errors"), ref: $("s3ref"), play: $("s3play"),
    speed: $("s3speed"), gap: $("s3gap"), rate: $("s3rate"), rot: $("s3rot"), backlight: $("s3back"),
    dist: $("s3dist"), win: $("s3win"), slip: $("s3slip"), lat: $("s3lat"), speedup: $("s3speedup"),
    cams: $("s3cams"), sev: $("s3sev"),
    map: $("s3map"), mapRot: $("s3mapRot"), mapCams: $("s3mapCams"), mapN: $("s3mapN"), mapTable: $("s3mapTable"),
    tCollect: $("s3tCollect"), tApply: $("s3tApply"), tN: $("s3tN"), tPrev: $("s3tPrev"), tCostF: $("s3tCostF"),
    tCostM: $("s3tCostM"), tPlot: $("s3tPlot"), tTable: $("s3tTable"), tNote: $("s3tNote"),
  });
  $("s3defects").innerHTML = '<span class="hint">Виды брака:</span>' + DEFECTS3D.map((d) =>
    `<label class="check"><input type="checkbox" value="${d}" checked> ${esc(LABELS3D[d])}</label>`).join("");
  el.play.addEventListener("click", () => {
    if (!run) return start();
    run.playing = !run.playing;
    el.play.textContent = run.playing ? "⏸ Пауза" : "▶ Пуск";
  });
  $("s3reset").addEventListener("click", () => {
    stopRun();
    start();
  });
  el.map.addEventListener("click", runMap);
  el.tCollect.addEventListener("click", collectTradeoff);
  [el.tPrev, el.tCostF, el.tCostM].forEach((x) => x.addEventListener("change", updateTradeoff));
  el.tApply.addEventListener("click", async () => {
    const s = +el.tApply.dataset.s;
    ({ result: recipe3d } = await py("scale_recipe_json", JSON.stringify(recipe3d), s));
    await updateTradeoff();  // кривая — уже относительно нового рецепта
    el.tApply.disabled = true;
    el.tApply.textContent = `Рецепт 3D: допуски ×${s} применены`;
  });
  document.querySelectorAll("[data-view3d]").forEach((b) => b.addEventListener("click", () => {
    if (three) setView(three, b.dataset.view3d, run ? run.p : params());
  }));
  status("Нажмите «Пуск»: загрузится Python в фоновом потоке, камера снимет эталон, и линия поедет.");
}
