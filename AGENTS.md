# Working on romdev-browser

GPL-2.0-only library: romdev's SDCC sm83 toolchain + gambatte core, run in Web Workers behind a
documented postMessage protocol (README.md). Consumers load `dist/*.worker.js` by URL; keep it that way —
no exports meant for bundling into other apps.

- Merge with a merge commit (`--no-ff`, `gh pr merge --merge`); never squash or rebase-merge.
- Upstream is the sibling checkout `../romdev`. Refresh `vendor/romdev/` by copying; never edit in place.
- The only change to the GPL binaries is the one-flag glue patch in `scripts/build.mjs`; keep NOTICE.md in sync
  with every component version bump (source URLs, commits, hashes).
- Any change to `dist/` behavior needs a version bump; protocol changes must be backward compatible or major.
- `src/toolchain.ts` / `src/rom.ts` also run in Node tests via type stripping: no enums or parameter properties,
  explicit `.ts` import extensions.
- Verify with `npm test` (toolchain + emulator in Node). Worker code is browser-only: check it through a consumer.
