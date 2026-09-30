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
it in a container for its MCP endpoint). Stateless; requests are served one at a time.

```
PORT=8080 [GAMELAB_KEY=secret] node dist/server.mjs
GET  /health
POST /build { platform: gb|gbc|nes, sources: { "main.c", ...extra .c/.h/.s }, title? }  -> { ok, stage, rom (base64), romBytesUsed, banks, issues, log, ms }
POST /run   { platform, rom, frames, input: [{ frame, until, buttons, touch?, touches? }], shots: [frame], every, memory: [{ region, offset, length }], sram? }
            -> { rows: [{ frame, memory: [hex] }], shots: [{ frame, png }], sram, ms }
```


### Network input (0.8.0)

`{type:"advance", id, frames:1..8, masks:[p1,p2]}` advances exactly the requested frames and replies with
`{hash}` (FNV-1a of system RAM and save RAM, for comparing matching frame checkpoints). No autonomous clock.
The mask bits from low to high are Right, Left, Up, Down, A, B, Select, Start. Both controller ports are set
(NES uses its two hardware ports). Network batches clear touch helpers and do not use link-cable emulation.
Single-player `step` is unchanged.

### Local rollback (0.9.0)

`{type:"networkBegin", id}` stores the loaded ROM's complete libretro state and replies with `{stateBytes}`.
`{type:"networkStep", id, frame, masks:[p1,p2], confirmed}` executes one frame, stores its full state, draws,
and emits forward audio. `frame` starts at zero; `confirmed` is the last canonical input frame, initially -1.
`{type:"networkReplay", id, from, inputs:[[p1,p2],...], confirmed}` restores the snapshot **before** `from`,
resimulates through the current frame, and draws the corrected final image. All replay audio is discarded.
Both step and replay reply with `[{seq,hash},...]` for frame 59, 119, etc. Hashes cover system and save RAM;
the caller compares them only after those inputs are confirmed and all corrections complete.

Snapshots remain inside the worker. Confirmed snapshots are pruned; an unconfirmed window above 64 frames
is rejected. The caller owns prediction, input transport, pacing and a smaller prediction limit (chiptoy uses 24).
Network requests clear touch helpers and set both native controller ports. Load/reset clears rollback history.
Do not mix autonomous `step`, reset, or probe with an active network session. No core/toolchain patch is required.

The optional `scripts/network-integration.mjs` harness boots independent fceumm instances and joins real
Cloudflare rooms over MCP/WebSockets. Pass the client timeline module path, a local/dev origin, a shared NES game
UUID, `pair` (two headless participants), an invitation UUID or `public` (join a waiting browser), added outbound
and inbound delay in ms, and test duration in seconds. Dev needs its authorized `MCP_BEARER` in the environment;
credentials and socket tickets are never printed. It checks canonical hashes, average frame rate and engine health,
reports prediction/stall/rollback counters, and cleans up its rooms. Live jitter may exhaust the prediction budget;
zero stalls are not asserted for an arbitrary Internet connection. The app never imports this harness or the core.

### Optional NES cartridge network menu (0.10.0)

A cartridge may advertise an ABI 1 mailbox at CPU $03E0: bytes `4E 58 01`,
command byte at $03E3 (`1` join, `2` invite, `3` leave), status at $03E4
(`0` unavailable, `1` idle, `2` connecting, `3` waiting, `4` playing, `5` ended).
Consumers implement authentication, matching, invitations and URL sharing outside
this GPL worker. The worker emits `{type:"networkAction", action:"join"|"invite"|"leave"}`
when a local cartridge submits a command, consuming the local command once.
`{type:"networkStatus", id, status}` sets a pre-match lobby status (1-5); it is
rejected while rollback is active. Unadvertised cartridges and Game Boy platforms
are untouched. Use a fresh zeroed-RAM ROM load after the local lobby and before
`networkBegin`; lobby duration and local identifiers must never become match state.
During both forward simulation and replay the worker writes the same playing
status to every advertised cartridge. Only a forward `networkStep` can emit leave;
replay emits no browser actions and never acknowledges command RAM. Do not write
local player ID, RTT, UID or connection-specific data into hashed cartridge RAM.

chiptoy's optional `network.h` wraps this mailbox as `net_init()`, `net_status()`,
`net_join()`, `net_invite()`, `net_leave()`. This is a browser capability: provide an
offline path when status stays 0, and expose invite sharing through a browser
button so a fresh user gesture can open the native share sheet.
