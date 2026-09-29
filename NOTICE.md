# Notices

romdev-browser is licensed under the GNU General Public License, version 2 only (see LICENSE).
It redistributes the following components. Everything below is unmodified except where noted.

| Component | Where | License | Corresponding source |
|---|---|---|---|
| gambatte (libretro core), WebAssembly built by romdev's `build-gambatte.sh` (package `romdev-core-gambatte` 0.12.1) | `dist/wasm/gambatte.wasm`, `gambatte.mjs` | GPL-2.0-only | https://github.com/libretro/gambatte-libretro at commit 3262c2aa4adae8dba4f6d51cdd931c15cb11569f with romdev's `scripts/patches/gambatte-romdev-memory-regions.patch`; build recipe `packages/romdevtools/scripts/build-gambatte.sh` in https://github.com/monteslu/romdev |
| SDCC (sdcc, mcpp, sdasgb, sdld) + sm83 headers/library, WebAssembly built by romdev's `build-sdcc.sh` / `build-mcpp.sh` (package `romdev-toolchain-sdcc` 0.2.2) | `dist/wasm/{sdcc,mcpp,sdasgb,sdld}.*`, `sdcc-share.json` | GPL-2.0-or-later (runtime library: GPL with linking exception, does not encumber compiled ROMs) | https://sourceforge.net/projects/sdcc/files/sdcc/4.4.0/ (sdcc-src-4.4.0.tar.bz2, sha256 ae8c12165eb17680dff44b328d8879996306b7241efa3a83b2e3b2d2f7906a75); build recipe `packages/romdevtools/scripts/build-sdcc.sh` in romdev |
| fceumm (libretro core), WebAssembly built by romdev's `build-fceumm.sh` (package `romdev-core-fceumm` 0.13.1) | `dist/wasm/fceumm.wasm`, `fceumm.mjs` | GPL-2.0-or-later | https://github.com/libretro/libretro-fceumm at commit 3a84a6fd0ba20dd4877c06b1d58741172148395f with romdev's `scripts/patches/fceumm-romdev-memory-regions.patch`; build recipe `packages/romdevtools/scripts/build-fceumm.sh` in romdev |
| cc65 (cc65, ca65, ld65) + headers, ca65 includes and `nes.lib`, WebAssembly built by romdev's `build-cc65.sh` (package `romdev-toolchain-cc65` 0.1.4) | `dist/wasm/{cc65,ca65,ld65}.*`, `cc65-share.json` | Zlib | https://github.com/cc65/cc65 at commit cc3c40c54e51b2d9a22b63c85c418a2b11763377 with romdev's `scripts/patches/cc65-reproducible-debug-info.patch`; build recipe in romdev |
| romdev-core-host 0.14.0 (bundled into `emulator.worker.js`) | `dist/emulator.worker.js` | MIT | https://github.com/monteslu/romdev/tree/main/packages/romdev-core-host |
| romdev GB/GBC C runtime (`gb_runtime.c`, `gb_crt0.s`, headers) and NES C runtime (`nes_runtime.c/.h`, `chr-ram-runtime.crt0.s`, `chr-ram-runtime.cfg`) | `vendor/romdev/`, bundled into `compiler.worker.js` and `server.mjs` | MIT | https://github.com/monteslu/romdev (commit in `vendor/romdev/COMMIT`) |

**Build source:** the WebAssembly and its JavaScript glue are built, unmodified, from romdev's own recipes in a
romdev checkout; `dist/manifest.json` → `wasmSource` records the exact repository and commit
(for 0.2.0: https://github.com/ssk-play/romdev at `9e7f40f58f82f05884225f84613234fa2a0214ab`, branch
`browser-environment`, proposed upstream as https://github.com/monteslu/romdev/pull/8). That commit links the glue with
`-s ENVIRONMENT=node,web,worker` instead of `node`; the `.wasm` binaries are otherwise the same (gambatte's is
byte-identical to the published npm package). Rebuild with `build-image/build-wasm.sh` (Emscripten 4.0.18 image).

ROMs produced with the toolchains are not covered by the GPL (SDCC's runtime library carries a linking exception;
cc65 and its libraries are Zlib; the romdev runtimes are MIT).
