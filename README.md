# romdev-browser

Build and play Game Boy / Game Boy Color C programs **entirely in the browser**, using the
WebAssembly toolchain and emulator core published by [romdev](https://github.com/monteslu/romdev)
(SDCC sm83 + gambatte). Unofficial; not affiliated with romdev.

Everything runs in two Web Workers. Pages talk to them only with `postMessage`, so they can be
served from any path and driven by any client.

```
dist/
  compiler.worker.js   C sources → 32 KB .gb/.gbc ROM (mcpp → sdcc → sdasgb → sdld → header fix)
  emulator.worker.js   gambatte on an OffscreenCanvas; audio PCM posted back to the page
  wasm/                emscripten glue + .wasm, unmodified from romdev's recipes (see NOTICE.md)
  manifest.json        version, component versions, uncompressed asset sizes
```

## Use

The WASM comes from a romdev checkout, not from the npm payloads: `package.json` points the `romdev-*`
dependencies at `../romdev/packages/*`, and the build refuses node-only glue. Until
[monteslu/romdev#8](https://github.com/monteslu/romdev/pull/8) is released, that checkout needs the
`node,web,worker` recipes (https://github.com/ssk-play/romdev, branch `browser-environment`) and its payloads rebuilt:

```bash
git clone -b browser-environment https://github.com/ssk-play/romdev ../romdev
cd ../romdev && npm ci --ignore-scripts && node scripts/fetch-payloads.mjs
for s in build-gambatte.sh build-sdcc.sh build-mcpp.sh; do ROMDEV_BUILD_CWD=packages/romdevtools build-image/build-wasm.sh $s; done
cp packages/romdevtools/src/toolchains/sdcc/wasm/{mcpp,sdcc,sdasgb,sdasz80,sdld}.{js,wasm} packages/romdev-toolchain-sdcc/wasm/
cd ../romdev-browser && npm install && npm run build      # → dist/
```

Serve `dist/` as static files (e.g. under `/lib/romdev-browser/<version>/`; immutable per version, so long cache
lifetimes are safe). Workers resolve `./wasm/*` relative to their own URL.

### Compiler worker

```js
const w = new Worker("/lib/romdev-browser/0.2.0/compiler.worker.js", { type: "module" });
w.postMessage({ type: "warmup" });                         // optional: start the ~21 MB download
w.postMessage({ type: "build", id: 1, input: { platform: "gbc", sources: { "main.c": src }, title: "MY GAME" } });
```

Events: `{type:"progress", loaded, total}` (uncompressed bytes), `{type:"ready"}`,
`{type:"result", id, result}`, `{type:"error", id, message}` (`id: -1` for a failed warmup).

`result`: `{ ok, stage: "compile"|"link"|"size"|"done", rom: Uint8Array|null, romBytesUsed, issues: [{file, line, severity, message}], log, ms }`.

Build recipe (romdev's GB C project recipe): the bundled `gb_crt0.s` (MBC1+RAM+BATTERY header,
vectors, BSS init) and `gb_runtime.c` are always linked; `gb_hardware.h`, `gb_runtime.h`, `font.h`
are on the include path; `_CODE=$0150`, `_DATA=$C200`; 32 KB, no bank switching.

### Emulator worker

```js
const w = new Worker("/lib/romdev-browser/0.2.0/emulator.worker.js", { type: "module" });
const off = canvas.transferControlToOffscreen();            // canvas is 160x144
w.postMessage({ type: "init", canvas: off }, [off]);        // → {type:"ready"}
w.postMessage({ type: "load", id: 1, rom, platform: "gbc", sram: null });
w.postMessage({ type: "step", frames: 1, buttons: { right: true, a: false } }); // from your rAF loop
```

Requests with an `id` get `{type:"reply", id, ok, value | error}`:
`load`, `reset`, `readSram` (battery RAM bytes or null), `probe` →
`{ blank, inputReactive, screenshot, screens }` (boots, presses Start and A, compares idle vs
Right+A from one save state, then restores battery RAM and resets). `step` has no reply and is
ignored while a request is running. Audio arrives as `{type:"audio", pcm: Int16Array (interleaved
stereo), rate}` after each step.

Pacing and input timing are the page's job (the page decides how many frames to step and holds
short taps long enough for the game to see them).

## Develop

```bash
npm install
npm test        # builds dist/, then toolchain + emulator tests in Node
```

## License

GPL-2.0-only. See LICENSE and NOTICE.md for bundled components and their sources.

## Headless service (`dist/server.mjs`)

The same toolchain and gambatte core behind HTTP, for a server that builds and runs games for someone (chiptoy runs
it in a container for its MCP endpoint). Stateless; requests are served one at a time.

```
PORT=8080 [GAMELAB_KEY=secret] node dist/server.mjs
GET  /health
POST /build { platform, sources: { "main.c", ...extra .c/.h }, title? }  -> { ok, stage, rom (base64), romBytesUsed, issues, log, ms }
POST /run   { platform, rom, frames, input: [{ frame, until, buttons }], shots: [frame], every, memory: [{ region, offset, length }], sram? }
            -> { rows: [{ frame, memory: [hex] }], shots: [{ frame, png }], sram, ms }
```

