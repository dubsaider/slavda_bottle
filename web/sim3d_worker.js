// Pyodide в фоновом потоке для 3D-линии: проверка кадров не подвешивает анимацию,
// а время проверки становится настоящей задержкой решения.
"use strict";
let web = null;
let ready = null;

async function init({ pyodide, modules, base }) {
  importScripts(pyodide + "pyodide.js");
  const py = await loadPyodide({ indexURL: pyodide });
  await py.loadPackage(["numpy", "opencv-python"]);
  py.FS.mkdirTree("/home/pyodide/bottlecheck");
  for (const m of modules) {
    const res = await fetch(new URL(`bottlecheck/${m}.py`, base), { cache: "no-cache" });
    if (!res.ok) throw new Error(`не загрузился bottlecheck/${m}.py (HTTP ${res.status})`);
    py.FS.writeFile(`/home/pyodide/bottlecheck/${m}.py`, await res.text());
  }
  web = py.pyimport("bottlecheck.web");
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.init) {
    ready = init(m.init);
    try {
      await ready;
      self.postMessage({ ready: true });
    } catch (err) {
      self.postMessage({ ready: false, error: String(err && err.message || err) });
    }
    return;
  }
  try {
    await ready;
    const t = performance.now();
    const result = web[m.fn](...m.args);
    self.postMessage({ id: m.id, result, ms: performance.now() - t });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
