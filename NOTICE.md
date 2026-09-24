# Notices

romdev-browser is licensed under the GNU General Public License, version 2 only (see LICENSE).
It redistributes the following components. Everything below is unmodified except where noted.

| Component | Where | License | Corresponding source |
|---|---|---|---|
| gambatte (libretro core), WebAssembly build from npm `romdev-core-gambatte` 0.12.1 | `dist/wasm/gambatte.wasm`, `gambatte.mjs` | GPL-2.0-only | https://github.com/libretro/gambatte-libretro at commit 3262c2aa4adae8dba4f6d51cdd931c15cb11569f with romdev's `scripts/patches/gambatte-romdev-memory-regions.patch`; build recipe `packages/romdevtools/scripts/build-gambatte.sh` in https://github.com/monteslu/romdev |
| SDCC (sdcc, mcpp, sdasgb, sdld) + sm83 headers/library, WebAssembly build from npm `romdev-toolchain-sdcc` 0.2.2 | `dist/wasm/{sdcc,mcpp,sdasgb,sdld}.*`, `sdcc-share.json` | GPL-2.0-or-later (runtime library: GPL with linking exception, does not encumber compiled ROMs) | https://sourceforge.net/projects/sdcc/files/sdcc/4.4.0/ (sdcc-src-4.4.0.tar.bz2, sha256 ae8c12165eb17680dff44b328d8879996306b7241efa3a83b2e3b2d2f7906a75); build recipe `packages/romdevtools/scripts/build-sdcc.sh` in romdev |
| romdev-core-host 0.14.0 (bundled into `emulator.worker.js`) | `dist/emulator.worker.js` | MIT | https://github.com/monteslu/romdev/tree/main/packages/romdev-core-host |
| romdev GB/GBC C runtime (`gb_runtime.c`, `gb_crt0.s`, headers) | `vendor/romdev/`, bundled into `compiler.worker.js` | MIT | https://github.com/monteslu/romdev at commit 5d73f1e24a1c076268fd2d518af72fff92d9871d |

**Modification:** the emscripten JavaScript glue of every WebAssembly binary above is changed in exactly one place —
`var ENVIRONMENT_IS_NODE=true` → `var ENVIRONMENT_IS_NODE=false` — by `scripts/build.mjs`, so the modules run in a browser.
The `.wasm` binaries themselves are byte-for-byte the published npm artifacts.

ROMs produced with the toolchain are not covered by the GPL (SDCC's runtime library carries a linking exception;
the romdev runtime is MIT).
