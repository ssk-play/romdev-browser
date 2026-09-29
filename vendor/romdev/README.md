Vendored from https://github.com/monteslu/romdev (MIT, see LICENSE) at commit f1996dda214472a188adc8ca2b6e6b21cc0f0718:
`packages/romdevtools/src/platforms/{gb,gbc}/lib/c/` — the C runtime every GB/GBC ROM links;
`nes/`: `packages/romdevtools/src/platforms/nes/lib/c/nes_runtime.{c,h}` and
`packages/romdevtools/src/toolchains/cc65/presets/nes/chr-ram-wram.{crt0.s,cfg}` — romdev's NES C project.
`tests/fixtures/` holds romdev example templates (MIT) used by the tests (`nes/platformer.c` from
`packages/romdevtools/examples/nes/templates/`).
Refresh by copying from the same paths in a romdev checkout; do not edit in place.
