# Notices

romdev-browser is licensed under the GNU General Public License, version 2 only (see LICENSE).
It redistributes the following components. Everything below is unmodified except where noted.

| Component | Where | License | Corresponding source |
|---|---|---|---|
| gambatte (libretro core), WebAssembly built by romdev's `build-gambatte.sh` (package `romdev-core-gambatte` 0.12.2) | `dist/wasm/gambatte.wasm`, `gambatte.mjs` | GPL-2.0-only | https://github.com/libretro/gambatte-libretro at commit 3262c2aa4adae8dba4f6d51cdd931c15cb11569f with romdev's `gambatte-romdev-memory-regions.patch`, `gambatte-multiplayer-state.patch` and shared debug sources; pinned build source below |
| SDCC (sdcc, mcpp, sdasgb, sdld) + sm83 headers/library, WebAssembly built by romdev's `build-sdcc.sh` / `build-mcpp.sh` (package `romdev-toolchain-sdcc` 0.2.3) | `dist/wasm/{sdcc,mcpp,sdasgb,sdld}.*`, `sdcc-share.json` | GPL-2.0-or-later (runtime library: GPL with linking exception, does not encumber compiled ROMs) | https://sourceforge.net/projects/sdcc/files/sdcc/4.4.0/ (sdcc-src-4.4.0.tar.bz2, sha256 ae8c12165eb17680dff44b328d8879996306b7241efa3a83b2e3b2d2f7906a75); romdev's patches and recipes in the pinned build source below |
| fceumm (libretro core), WebAssembly built by romdev's `build-fceumm.sh` (package `romdev-core-fceumm` 0.13.2) | `dist/wasm/fceumm.wasm`, `fceumm.mjs` | GPL-2.0-or-later | https://github.com/libretro/libretro-fceumm at commit 3a84a6fd0ba20dd4877c06b1d58741172148395f with romdev's `fceumm-romdev-memory-regions.patch`, `fceumm-multiplayer-state.patch` and shared debug sources; pinned build source below |
| cc65 (cc65, ca65, ld65) + headers, ca65 includes and `nes.lib`, WebAssembly built by romdev's `build-cc65.sh` (package `romdev-toolchain-cc65` 0.1.5) | `dist/wasm/{cc65,ca65,ld65}.*`, `cc65-share.json` | Zlib | https://github.com/cc65/cc65 at commit cc3c40c54e51b2d9a22b63c85c418a2b11763377 with romdev's `scripts/patches/cc65-reproducible-debug-info.patch`; build recipe in romdev |
| romdev-core-host 0.14.1 (bundled into the emulator/bundle workers and headless service) | `dist/{emulator.worker,bundle.worker}.js`, `dist/server.mjs` | MIT | https://github.com/ssk-play/romdev/tree/54c8a4014b3e4b2f36848d01d0eb7ed8d280beed/packages/romdev-core-host |
| romdev GB/GBC C runtime (`gb_runtime.c`, `gb_crt0.s`, headers) and NES C runtime (`nes_runtime.c/.h`, `chr-ram-wram.crt0.s`, `chr-ram-wram.cfg`) | `vendor/romdev/`, bundled into `compiler.worker.js` and `server.mjs` | MIT | https://github.com/monteslu/romdev (commit in `vendor/romdev/COMMIT`) |

**Build source for 1.7.1:** https://github.com/ssk-play/romdev/tree/54c8a4014b3e4b2f36848d01d0eb7ed8d280beed
(the fork's `browser-environment` with upstream monteslu/romdev main merged on 2026-10-30, ssk-play/romdev PR #11).
Package versions follow upstream's numbering since that sync.
All core/toolchain patches, shared debug/multiplayer C sources and pinned upstream
versions are under `packages/romdevtools/scripts/` in that source. The MIT runtime
copy is pinned separately in `vendor/romdev/COMMIT` (`54c8a4014b3e4b2f36848d01d0eb7ed8d280beed`).
The WebAssembly and glue are copied unmodified from romdev's recipes; they are not
patched npm payloads. `dist/manifest.json` → `wasmSource` records the actual checkout
and dirtiness. Rebuild using `build-image/build-wasm.sh` (Emscripten 4.0.18 image).
The reproducible core/toolchain payload is published at
https://github.com/ssk-play/romdev/releases/tag/browser-payloads-6f59c4b0d7a7
(archive SHA-256 `2ef2943b9891c0ca98e592dbfd5b6c5ba7ade5544268821b0b3d722ab4e540d7`).

ROMs produced with the toolchains are not covered by the GPL (SDCC's runtime library carries a linking exception;
cc65 and its libraries are Zlib; the romdev runtimes are MIT).
