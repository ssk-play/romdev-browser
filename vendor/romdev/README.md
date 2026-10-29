Vendored from https://github.com/ssk-play/romdev, a fork of https://github.com/monteslu/romdev (MIT, see LICENSE), at commit 54c8a4014b3e4b2f36848d01d0eb7ed8d280beed:
`packages/romdevtools/src/platforms/{gb,gbc}/lib/c/` — the C runtime every GB/GBC ROM links;
`nes/`: `packages/romdevtools/src/platforms/nes/lib/c/nes_runtime.{c,h}` and
`packages/romdevtools/src/toolchains/cc65/presets/nes/chr-ram-wram.{crt0.s,cfg}` — romdev's NES C project.
`tests/fixtures/` holds romdev example templates (MIT) used by the tests (`nes/platformer.c` from
`packages/romdevtools/examples/nes/templates/`).
Refresh by copying from the same paths in a romdev checkout; do not edit in place.
