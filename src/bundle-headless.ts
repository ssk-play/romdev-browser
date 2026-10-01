import { ConsoleBundle, type HostFactory } from "./bundle.ts";
import { BundleReplay } from "./bundle-replay.ts";
import { boundaryDigest } from "./bundle-checkpoint.ts";
import { copyInput, validateConfig, type BundleConfig, type FrameInput } from "./multiplayer.ts";
import { WorldObserver, type WorldObservation } from "./world-observation.ts";

export interface BundleRunRequest {
  config: BundleConfig;
  rom: string;
  frames: number;
  input?: FrameInput[];
  shots?: number[];
  every?: number;
  memory?: { region: "system_ram" | "save_ram"; offset: number; length: number }[];
  world?: WorldObservation;
}
/** Headless adapter. Optional world validation uses an explicit nonintrusive
 * engine publication hook; raw native-boundary reads remain distinct. */
export async function runBundle(
  req: BundleRunRequest,
  build: string,
  factory: HostFactory,
  encodePng: (rgba: Uint8Array, width: number, height: number) => string,
) {
  const started = performance.now();
  validateConfig(req.config);
  if (
    !Number.isInteger(req.frames) ||
    req.frames < 1 ||
    req.frames > 3600 ||
    typeof req.rom !== "string" ||
    req.rom.length > 12 * 1024 * 1024
  )
    throw new Error("invalid bundle run bounds/ROM");
  const inputs = req.input ?? [],
    shots = req.shots ?? [],
    reads = req.memory ?? [],
    every = req.every ?? 0;
  if (!Array.isArray(inputs) || inputs.length > req.frames)
    throw new Error("invalid bundle input trace");
  const trace = inputs.map((f, i) => {
    const c = copyInput(req.config, f);
    if (c.frame !== i) throw new Error("non-contiguous bundle input trace");
    return c;
  });
  if (
    !Array.isArray(shots) ||
    shots.length > 8 ||
    shots.some((f) => !Number.isInteger(f) || f < 1 || f > req.frames) ||
    !Number.isInteger(every) ||
    every < 0 ||
    every > req.frames
  )
    throw new Error("invalid bundle sampling");
  if (
    !Array.isArray(reads) ||
    reads.length > 32 ||
    reads.some(
      (m) =>
        !m ||
        !["system_ram", "save_ram"].includes(m.region) ||
        !Number.isInteger(m.offset) ||
        m.offset < 0 ||
        !Number.isInteger(m.length) ||
        m.length < 1 ||
        m.length > 256,
    )
  )
    throw new Error("invalid bundle memory inspection");
  const stops = new Set([...shots, req.frames]);
  if (every) for (let f = every; f < req.frames && stops.size < 64; f += every) stops.add(f);
  const bundle = await ConsoleBundle.boot(
    req.config,
    Uint8Array.from(Buffer.from(req.rom, "base64")),
    build,
    factory,
  );
  let replay: BundleReplay | null = null;
  let world: WorldObserver | null = null;
  try {
    if (req.world) world = new WorldObserver(bundle, req.world);
    replay = new BundleReplay(bundle);
    for (const v of bundle.consoles)
      for (const m of reads)
        if (m.offset + m.length > v.host.regionSize(m.region))
          throw new Error("bundle inspection outside memory region");
    const rows: unknown[] = [],
      pictures: unknown[] = [];
    for (let f = 0; f < req.frames; f++) {
      const input = trace[f] ?? {
        frame: f,
        masks: [0, 0, 0, 0],
        states: [0, 1, 2, 3].map((s) => (req.config.slots.includes(s) ? 1 : 0)),
      };
      replay.enqueue(input as FrameInput);
      while (!replay.pump().complete) {}
      replay.drainAudio();
      replay.confirm(f);
      world?.collect(bundle, f + 1);
      if (stops.has(f + 1))
        rows.push({
          frame: f + 1,
          consoles: bundle.consoles.map((v) => ({
            slot: v.slot,
            memory: reads.map((m) =>
              Buffer.from(v.host.readMemory(m.region, m.offset, m.length)).toString("hex"),
            ),
          })),
        });
      if (shots.includes(f + 1))
        pictures.push({
          frame: f + 1,
          consoles: bundle
            .pixels()
            .map((p, i) => ({
              slot: bundle.consoles[i].slot,
              png: encodePng(p.rgba, p.width, p.height),
            })),
        });
    }
    const boundary = replay.checkpoint(req.frames - 1);
    return {
      build,
      descriptor: bundle.descriptorHash,
      consoleSlots: bundle.consoles.map((v) => v.slot),
      schemas: boundary.states.map((s) => s.schema),
      snapshotBytes: replay.snapshotBytes,
      digest: await boundaryDigest(bundle.descriptorHash, boundary, {
        eventSeq: -1,
        chainHash: "0000000000000000",
      }),
      world: world?.result() ?? null,
      rows,
      shots: pictures,
      ms: performance.now() - started,
    };
  } finally {
    world?.dispose(bundle);
    if (replay) replay.dispose();
    else bundle.dispose();
  }
}
