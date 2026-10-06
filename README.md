# romdev-browser

Build and play Game Boy / Game Boy Color and NES C programs **entirely in the browser**, using the
WebAssembly toolchains and emulator cores published by [romdev](https://github.com/monteslu/romdev)
(SDCC sm83 + gambatte for GB/GBC, cc65 + fceumm for NES). Unofficial; not affiliated with romdev.

Everything runs in two Web Workers. Pages talk to them only with `postMessage`, so they can be
served from any path and driven by any client.

```
dist/
  compiler.worker.js   C sources → .gb/.gbc ROM (mcpp → sdcc → sdasgb → sdld → header fix)
                       or .nes ROM (cc65 → ca65 → ld65); each toolchain downloads when first needed
  emulator.worker.js   the platform's core (gambatte, fceumm) on an OffscreenCanvas; audio PCM posted back
  server.mjs           the same builds and cores headless over HTTP (see below)
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
const w = new Worker("/lib/romdev-browser/0.7.0/compiler.worker.js", { type: "module" });
w.postMessage({ type: "warmup", platform: "gbc" });        // optional: start the toolchain download (SDCC ~21 MB, cc65 ~5 MB)
w.postMessage({ type: "build", id: 1, input: { platform: "gbc", sources: { "main.c": src }, title: "MY GAME" } });
```

Events: `{type:"progress", loaded, total}` (uncompressed bytes), `{type:"ready"}`,
`{type:"result", id, result}`, `{type:"error", id, message}` (`id: -1` for a failed warmup).

`result`: `{ ok, stage: "compile"|"link"|"size"|"done", rom: Uint8Array|null, romBytesUsed, issues: [{file, line, severity, message}], log, ms }`.

Build recipe (romdev's GB C project recipe): the bundled `gb_crt0.s` (MBC1+RAM+BATTERY header,
vectors, BSS init) and `gb_runtime.c` are always linked; `gb_hardware.h`, `gb_runtime.h`, `font.h`
are on the include path; `_CODE=$0150`, `_DATA=$C200`; 32 KB, plus MBC5 banks for `#pragma constseg/codeseg CODE_<n>`.

NES (romdev's NES C project): `cc65 -t nes -Oirs` and `ca65 -t nes` per source (`.c`, `.s`), linked by ld65 with romdev's
`chr-ram-wram` config and crt0 (iNES header: 32 KB PRG-ROM, CHR-RAM, vertical mirroring, battery PRG-RAM at
`$6000`; C BSS/DATA at `$6100-$7FFF`, 7.75 KB; `$6000-$60FF` is a save area the crt0 never clears; NMI: OAM DMA,
VRAM queue, palette, scroll) and `nes_runtime.c` (neslib-shaped: `ppu_*`, `oam_spr`,
`pad_poll`, `chr_ram_upload`, `tile_set`, `text_draw`, `sound_*`, `hiscore_load/save`; include `nes_runtime.h`).

### Emulator worker

```js
const w = new Worker("/lib/romdev-browser/0.7.0/emulator.worker.js", { type: "module" });
const off = canvas.transferControlToOffscreen();            // takes the core's screen size on load
w.postMessage({ type: "init", canvas: off, platform: "gbc" }, [off]); // → {type:"ready"}; platform (optional) preloads its core
w.postMessage({ type: "load", id: 1, rom, platform: "gbc", sram: null }); // → { width, height, fps }
w.postMessage({ type: "step", frames: 1, buttons: { right: true, a: false }, touches: [{ x: 80, y: 72 }] }); // from your rAF loop
```

Requests with an `id` get `{type:"reply", id, ok, value | error}`:
`load` (→ `{ width, height, fps }`: the core's screen, which the canvas now has, and the frame rate to step at), `reset`,
`readSram` (battery RAM bytes or null), `probe` →
`{ blank, inputReactive, screenshot, screens }` (boots, presses Start and A, compares idle vs
Right+A from one save state, then restores battery RAM and resets). `step` has no reply and is
ignored while a request is running. Audio arrives as `{type:"audio", pcm: Int16Array (interleaved
stereo), rate}` after each step.

Pacing and input timing are the page's job (the page decides how many frames to step and holds
short taps long enough for the game to see them).

Touch (optional; real hardware has none): `touches` is the fingers on the game screen in the screen's pixels, slot by
slot (slot i is the same finger from landing to lifting; null: none there). Only a game that asks for touch gets it: its
engine writes a 6-byte header at $D0F8 (gb/gbc, system_ram 0x10F8) or $03F8 (nes): magic `"TC"` (0x54 0x43), the
address of its finger buffer (little-endian; work RAM, or the cart's RAM for cc65 statics), how many fingers it holds,
and a byte the worker sets to the number down. Before every step the worker writes each slot as [down 0/1, x, y]; a
lifted finger keeps where it let go. Other games' RAM is never touched. The server's `/run` takes `touch: {x, y}`
(slot 0) or `touches: [...]` on an input entry.

## Develop

```bash
npm install
npm test        # builds dist/, then toolchain + emulator tests in Node
```

## License

GPL-2.0-only. See LICENSE and NOTICE.md for bundled components and their sources.

## Headless service (`dist/server.mjs`)

The same toolchain and gambatte core behind HTTP, for a server that builds and runs games for someone (chiptoy runs
it in a container for its MCP endpoint). Stateless; requests are served one at a time on a job thread, so the HTTP
thread always answers. At most `GAMELAB_QUEUE_MAX` (default 4) wait or run: a full queue answers
`503 { error: "busy: …" }` at once, and a request whose caller hung up before its turn is skipped. A job past
`GAMELAB_JOB_MS` (default 45000) is stopped (`504`) by terminating the job thread; the next job starts a fresh one.
The toolchain keeps compiled units, so a rebuild compiles only the `.c` files whose preprocessed text changed. A host
that sends `objects` with `/build` (even `{}`) gets this build's units back (gb/gbc) and can send them with a later
build, so a fresh process also recompiles only what changed; units of another romdev-browser version are ignored.

```
PORT=8080 [GAMELAB_KEY=secret] [GAMELAB_QUEUE_MAX=4] [GAMELAB_JOB_MS=45000] node dist/server.mjs
GET  /health -> { ok, version, queued, runningMs, skipped, stopped }
POST /build { platform: gb|gbc|nes, sources: { "main.c", ...extra .c/.h/.s }, title?, objects? }  -> { ok, stage, rom (base64), romBytesUsed, banks, issues, log, ms, objects? }
POST /run   { platform, rom, frames, input: [{ frame, until, buttons, touch?, touches? }], shots: [frame], every, memory: [{ region, offset, length }], sram? }
            -> { rows: [{ frame, memory: [hex] }], shots: [{ frame, png }], sram, ms }
POST /bundle/run { config, rom, frames, input?: FrameInput[], shots?: number[], every?, memory?: [{region,offset,length}] }
            -> { build, descriptor, consoleSlots, schemas, digest, snapshotBytes, rows, shots, ms }
```

`/build` and the compiler worker also accept an optional `memoryContract`:
`{abi:1,engineFiles:{"engine.c":<sha256>,"engine.h"?:<sha256>,"engine.s"?:<sha256>},contextSymbol}`.
The host supplies it only after recognizing its pinned, read-only MP engine; game
JSON cannot opt into or redefine that trust. SDCC's existing `.adb` plus generated
assembly supply folded absolute object addresses and complete sizes; cc65 uses
its preprocessed C, generated assembly and verbose linker map. The contract
rejects game allocations crossing MP/TC header bytes (`$D0F0–$D0FF` / `$03F0–$03FF`),
RAM mirrors, the engine's linked 32-byte context, and unverifiable raw absolute
assembly definitions. Typed constant pointer aliases/literal writes supplement
allocation records, including macros and included assembly. Legitimate computed
indirect accesses remain permitted: this is a build-time ownership check and
authoring rule, not a malicious-ROM memory sandbox. Old solo builds omit the
contract; chiptoy's new engine/state-page recognition and guides belong to M3.

`/bundle/run` boots fresh isolated cores using the exact worker adapter. It accepts
up to 3600 native frames and a contiguous zero-based trace; any remaining frames
use neutral inputs and the initial active seats. Sampling uses completed-frame
counts, at most 64 stops, 8 screenshot stops and 32 memory reads of at most 256
bytes each. Rows/shots contain an ordered `consoles` array with canonical slot
and per-console memory/PNG. Final `digest` uses an offline empty stream position,
not a room certificate. All cores are disposed after each request. Raw memory
samples at native boundaries are **not** M3's pre-render logical-world equality
check. Optional `world {trigger, tick, fields, value?}` binds the lower core's
nonintrusive observation hook. The engine writes an unbanked LE32 tick and then
marker `0xa5` after world update and before drawing; physical RAM fields are copied
at that write. The diagnostic compares matching logical ticks, rejects repeated/
missing publications, overflow and more than eight unmatched ticks, and reports
trailing unmatched ticks separately. Differences identify tick, canonical slots,
field, physical offset and both values. Bounds are 32 named fields and 1024 bytes;
engine context/header/tick overlaps are rejected. This low-level binding is trusted
host input: M3 must derive publisher symbols from the pinned engine, validate the
author's world schema, and preserve publication in shared/solo execution.
It does not synchronize consoles whose game logic consumes different inputs.


### Deterministic console bundles (1.0.0)

The experimental network advance/rollback commands, cartridge lobby mailbox and
legacy network bridge have been removed. There is no compatibility layer.
Ordinary solo playback still uses `emulator.worker.js`.

`bundle.worker.js` is a separate worker for the multiplayer emulator contract.
It does not open sockets, choose a transport, predict inputs or authorize rooms.
Clients own those decisions and communicate only through postMessage.

- `init {canvas}` transfers an OffscreenCanvas; `load {rom, config}` starts an epoch
  with standard zero cartridge RAM, fixed deterministic RTC and the new MP ABI.
  `config` fixes platform, shared/player-views mode, occupied slots, capacity,
  epoch, seed, spike policy, prediction window (1–60) and RTC epoch seconds. Unknown
  config keys are rejected and descriptor hashing uses a fixed-order tuple.
- Shared mode runs one console. GB/GBC player-views runs the same ordered N consoles
  on every client, with each console's ROM slot fixed for its lifetime. Two players
  use two consoles; occupied slots may have gaps. NES always runs one console with
  native ordinary/Four Score controllers and an engine-owned RAM mirror.
- `frame {input}` queues one contiguous input vector (frame, four masks, four seat
  states), then performs a bounded slice. `pump` continues incomplete work. Neither
  command advances on its own clock. The default slice is 8ms and 128 native
  operations at most; a native frame/save/restore cannot be preempted and overshoot
  is reported. The caller must keep input capture independent of this worker.
- `correct {inputs, confirmed}` reconciles provisional inputs against the DO's
  immutable confirmed stream. Multiple unfinished corrections coalesce. `confirm`
  moves the watermark without changing masks. Partial consoles stay hidden;
  historical replay audio is discarded. `view {slot}` selects output without
  changing any console's deterministic state (`0xff` selects the shared view).
- `digest {afterFrame, position}` returns agreement metadata without copying native
  snapshot buffers; the boundary must still be corrected, confirmed and retained.
- `checkpoint {afterFrame, position}` returns a bounded full bundle with descriptor,
  core schemas, ordered causal digests and stream position. Byte integrity and
  agreement digest are separate. `restore` validates the envelope before restoring
  every canonical console. Room certification and checkpoint upload are the host's
  responsibility, outside the input connection. After restore, the last complete
  image is held and `presentationStale` remains true until a complete new frame.
- `inspect` permits bounded RAM reads only at completed, corrected boundaries.
  Optional diagnostic `probe {region}` checksums at most 4096 selected-view pixels
  and returns `pixelHash` with frame/pump replies; null disables it. This checksum
  is output telemetry, never a state digest or input to simulation.
  `dispose` releases the bundle. Replies are `{type:"reply", id, ok, value/error}`;
  forward audio is a separate transferred PCM event. Errors do not turn partial
  state into a displayed or certified bundle.

Input mask bits are Right, Left, Up, Down, A, B, Select, Start. Slot states are
absent=0, active=1, held=2, inactive=3, left=4. User IDs, local client numbers,
network clocks and connection data never enter emulated RAM. The ABI context's
`my_slot` belongs to the canonical console, not the browser viewing it.

`dist/benchmark/index.html?profile=smoke` automatically exercises actual cartridge
fixtures across 15 platform/mode/player-count combinations. The default full
profile adds 10-minute sustained runs for GBC four views and NES four pads.
A same-origin host iframe receives JSON diagnostics over postMessage; the library
never imports the host's authentication or application code. The page also works
standalone and offers a report download. A report is evidence, not acceptance:
see [the performance gate](docs/multiplayer-performance.md). Physical Android/iPhone
measurements and room/network integration remain separate. Visible response uses
changed P1 pixels and the next animation-frame paint opportunity: it is a software
estimate, not a measurement of physical display photons. Inputs during correction
are synthetic; the offline baseline also accepts the visible hold button (hold
at least 50ms). Reports distinguish missing memory/latency samples from zero.

`dist/benchmark/world-check.html` separately runs nine logical-world cases in a
real browser worker: GB/GBC one/two/four views, NES four pads, and two intentionally
invalid slot-dependent worlds. It compares every native frame's raw snapshot and
causal digest against uninstrumented execution and checks pixel parity. Normal
different cameras must pass; invalid simulation must fail at tick 1 with the
precise `score` field mismatch. No observations are enabled in performance runs.
