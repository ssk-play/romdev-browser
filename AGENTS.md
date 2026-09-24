# Working on romdev-browser

GPL-2.0-only library: romdev's SDCC sm83 toolchain + gambatte core, run in Web Workers behind a
documented postMessage protocol (README.md). Consumers load `dist/*.worker.js` by URL; keep it that way —
no exports meant for bundling into other apps.

- Merge with a merge commit (`--no-ff`, `gh pr merge --merge`); never squash or rebase-merge.
- Upstream is the sibling checkout `../romdev`. Refresh `vendor/romdev/` by copying; never edit in place.
- WASM + glue come unmodified from the sibling `../romdev` checkout (`file:` deps), built with romdev's own recipes
  (`build-image/build-wasm.sh`). Never patch glue here; fix the recipe in romdev (upstream PR) and rebuild there.
  `scripts/build.mjs` refuses node-only glue and records the romdev commit in `dist/manifest.json` (`wasmSource`);
  keep NOTICE.md's source pointer in sync with it.
- Any change to `dist/` behavior needs a version bump; protocol changes must be backward compatible or major.
- `src/toolchain.ts` / `src/rom.ts` also run in Node tests via type stripping: no enums or parameter properties,
  explicit `.ts` import extensions.
- Verify with `npm test` (toolchain + emulator in Node). Worker code is browser-only: check it through a consumer.
