/// <reference lib="dom" />
const worker = new Worker(new URL('./world-check.worker.js', import.meta.url), {type: 'module'});
const status = document.querySelector('#status')!, results = document.querySelector('#results')!;
const timer = setTimeout(() => { status.textContent = 'FAIL: diagnostic timed out'; worker.terminate(); }, 60_000);
worker.onmessage = e => {
  results.textContent = JSON.stringify(e.data, null, 2);
  status.textContent = e.data.error ? `FAIL: ${e.data.error}` : e.data.complete ? `PASS: ${e.data.results.length} world checks, including deliberately invalid games.` : `${e.data.results.length} world checks passed…`;
  if (e.data.error || e.data.complete) { clearTimeout(timer); worker.terminate(); }
};
worker.onerror = () => { clearTimeout(timer); status.textContent = 'FAIL: diagnostic worker failed'; worker.terminate(); };
window.addEventListener('pagehide', () => { clearTimeout(timer); worker.terminate(); });
worker.postMessage({type: 'start'});
