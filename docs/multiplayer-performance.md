# M2 performance gate: complete deterministic snapshots

The pre-M1 design probes used incomplete, smaller state formats. Their timing
figures are historical evidence, not the acceptance baseline. Every M2 report
must record the exact ROM, core/schema/build, occupied slots, canonical consoles,
prediction window and actual snapshot lengths. Shared-screen play always uses
one console. GB/GBC player-view mode uses one console for each initially occupied
slot; a two-player game pays for two consoles, not four. Four-player NES still
runs one console with native Four Score input.

## Snapshot memory with the external M1 fixtures

Windows Chrome 154 reported GB 72,285 B, GBC 96,861 B and NES 183,926 B.
The current LCD-state follow-up adds 16 B per GB/GBC console (schema 0x47420102).
For a window of 24 frames, retain at most 25 completed bundle boundaries.

| Case | Current bytes / console | Canonical consoles | 25-boundary snapshot payloads |
| --- | ---: | ---: | ---: |
| GB shared | 72,301 | 1 | 1,807,525 B (1.808 MB) |
| GB two views | 72,301 | 2 | 3,615,050 B (3.615 MB) |
| GB four views | 72,301 | 4 | 7,230,100 B (7.230 MB) |
| GBC shared | 96,877 | 1 | 2,421,925 B (2.422 MB) |
| GBC two views | 96,877 | 2 | 4,843,850 B (4.844 MB) |
| GBC four views | 96,877 | 4 | 9,687,700 B (9.688 MB) |
| NES four players | 183,926 | 1 | 4,598,150 B (4.598 MB) |

MB means 1,000,000 bytes. These are fixture-specific retained payloads, not total
process memory or a promise that every cartridge has the same snapshot size.
Reports also include the peak actual retained history, each WASM heap and their
sum, one partial bundle, selected/cached framebuffers, audio queues, checkpoint
copies/encoding and temporary native serialization/digest buffers. Core heaps
can grow and must be sampled after correction, not only at initial load.
JavaScript object overhead, GC and browser process peak need separate device
measurements; unavailable APIs are reported as unavailable, not zero memory.

## Charge all work in a correction

For canonical consoles i and correction depth d:

`T = sum(restore_i) + d * sum(native_step_i + capture_i) + scheduler bookkeeping`

Here capture includes native serialization, its JS buffer copy and the
core-owned digest. The present digest implementation **serializes again inside
the core before SHA-256**. Thus counting just one serialization per capture
understates both CPU and temporary-buffer work. Restore measurements include
core restore, replay-audio draining, ABI checking and restored digest checking.
No FIR/blipper history or causal state may be dropped to meet a budget.

Measure complete bursts directly; multiplying a per-frame p95 by 24 does not
produce a burst p95. Measure both total correction CPU time and elapsed time until
a complete corrected bundle is presented. A sliced replay holds the last complete
image and discards replay audio; presenting that same image every rAF is not 60
fresh frames per second. Slicing is not a performance pass by itself.

## Named physical-phone gate

On a named midrange Android and an iPhone, run actual GB/GBC shared and player-view
cartridges at 1, 2 and 4 occupied slots, plus an actual four-player NES cartridge.
Use maximum depth 24 and repeated/coalesced corrections, with a two-player baseline.
The automated harness must report:

- Whole-correction CPU and completion latency p50/p95/p99/max, plus restore,
  native step, snapshot/digest and per-slice costs. An unpreemptible native frame
  can exceed the 8 ms slice budget; report its overshoot.
- Fresh presentation count, held-image duration and p95/p99 presentation intervals,
  local input capture/send age and button-to-visible latency versus offline mode.
- Measured snapshot/heap peaks, available process/JS memory, GC tails and results
  over ten minutes to expose sustained/thermal behavior.
- Exact browser/WebView, OS/device, ROM and source/core build identities. Headless
  input bots fill unoccupied test clients; they cannot substitute for real-phone
  rendering, touch or main-thread measurements.

Use the native core's frame period. A synchronous correction fits only when its
CPU plus normal emulation, input, presentation, IPC and GC fit that period.
For sliced work, each presentation budget must fit and total catch-up time must
also pass. Retain the approved presentation targets (average at least 59 fresh fps,
p95 interval at most 20 ms and p99 at most 33.4 ms outside outages) and added local
input-response p95 at most one native frame against the corresponding offline mode.
No room integration or mobile pass is claimed from desktop timing alone.

### Automatic browser harness

`dist/benchmark/index.html?profile=smoke&device=<label>` runs two maximum-depth
corrections per case; the full profile (omit `profile`) excludes two warm-up bursts,
runs at least 18 measured bursts per case, and sustains the GBC four-view and NES
four-pad cases for ten minutes each. It takes about 25 minutes. Keep it foreground
and identify the physical device; visibility interruptions are reported. All 15
platform/mode/count cases use actual cartridges, not simulated core stubs. Pacing
uses native fps even on 120Hz displays. Every corrected bundle must equal an
uninterrupted reference checkpoint before any report can claim correctness.

The library works standalone with a report download, or emits partial/final JSON
reports to a same-origin host iframe. The separate chiptoy dev validation host
automatically creates an anonymous Firebase identity when needed and uploads a
whitelisted private report; no application/authentication code enters this GPL
program. It provides local bot vectors for the other 1–3 seats, not live remote
network clients. Live peer/RTT/loss tests remain M4v and later.

Correction CPU sums all slices; elapsed completion includes yielding and worker
messaging. Phase totals may include a newly queued normal frame in the completion
slice; the whole-correction CPU counter stops at correction completion. A synthetic
P1 input is queued while replay is unfinished. Its response matches the isolated
P1 sprite-region checksum from an uninterrupted reference, then waits for the next
animation-frame paint opportunity. The offline baseline records rising input
onsets the same way (synthetic pulses and optional physical button holds). Other
actors cannot trigger this pixel probe; actual-core tests cover that isolation.
This is a software visible-response estimate, **not physical photon latency**.
Manual onset count is reported separately. Use at least 50ms for a real button hold.

`normalFreshFps` and normal presentation intervals describe the paced, fresh
forward phase, excluding fixture restoration and held corrections. Held intervals
are separate stalls. Re-presenting a held image is never counted as a fresh frame.
CPU/slice tails expose GC/scheduling costs; JS heap is sampled where the browser
exposes it, and process memory/temperature/live network are unavailable. A completed
smoke report is a correctness diagnostic, not a phone or thermal acceptance pass.

If the gate fails: first shorten the frozen player-view prediction window with a
matching room deadline/window contract; then bound/coalesce replay over multiple
presentations and measure the visible catch-up cost; then evaluate sparser
snapshots including up to k-1 extra replay frames. A view-buffer rendering design
requires separately reviewed engine/core changes. None of these steps is an
automatic waiver of either screen mode or the physical-phone gate.

GB/GBC MP fixtures include 32 KiB cartridge RAM so the tested snapshots match
the larger M1-size baseline rather than a RAM-free cartridge. The current core
allocates a 32 MiB WASM heap per console: four player-view consoles therefore
reserve 128 MiB before snapshot history and JS/browser overhead. This is measured
linear-memory capacity, not a measured browser-process RSS peak.

## Reproducible desktop diagnostic

`npm run build && node scripts/bundle-cost.mjs <report.json>` uses the actual
cartridge fixtures and bundle scheduler. It records 20 warm-up and 200 measured
24-frame corrections per case, actual history/heap sizes, complete synchronous
burst and maximum replay-slice percentiles. It includes current serialization
and core-owned digest work. Source dirtiness and the build fingerprint are
explicit. It does not measure browser rendering/IPC/network, phone response or
thermal behavior and cannot pass the phone gate. Append `worst` to run only the
GBC four-view and NES four-player cases. Run the timing probe separately from
build/tests and other benchmark processes; do not use a concurrent test run as
a clean timing sample.

## Updated desktop diagnostic (2026-10-01)

The current MP fixture has 32 KiB cart RAM and four independently controlled
actors. After warm-up, 200 complete 24-frame corrections measured through the
actual bundle scheduler gave the following diagnostic. Build/tests and other
benchmark runs had finished before this run. Device: Apple M3 Max, macOS arm64,
Node v25.9.0. The code is still the unreviewed
M2 worktree; the pinned core is romdev `41a1c156`, schema 0x47420102 for GB/GBC.
ROM hashes and exact build/source identity are in `multiplayer-desktop-cost.json`.

| Actual case | Snapshot history | WASM heap capacity | Full correction p95 / p99 | Maximum 8 ms replay slice |
| --- | ---: | ---: | ---: | ---: |
| GBC four player views | 9,687,700 B | 134,217,728 B | 57.03 / 58.46 ms | 8.97 ms |
| NES four native players | 4,598,150 B | 33,554,432 B | 28.29 / 28.78 ms | 9.41 ms |

These whole corrections already exceed a native frame on this desktop. The
non-preemptible operation also overshoots the nominal replay-slice budget.
The old design-probe timing is therefore superseded for this implementation.
Do not claim synchronous 24-frame replay fits, or mark M2's phone gate passed.
The phone harness must still measure corrected-image completion, fresh frame
intervals and local response when replay is split; total CPU work alone cannot
establish acceptable gameplay.
