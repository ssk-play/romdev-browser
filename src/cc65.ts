// cc65 C (and ca65 assembly) → NES ROM, entirely in MEMFS. Mirrors romdev's NES C project recipe: `cc65 -t nes`,
// `ca65 -t nes`, and ld65 with romdev's chr-ram-wram config and crt0 (iNES header: 32 KB PRG-ROM, CHR-RAM, vertical
// mirroring, battery PRG-RAM at $6000 holding the C BSS/DATA at $6100-$7FFF and a 256-byte save area below; the NMI
// handler runs OAM DMA, the VRAM queue, palette and scroll), with
// nes_runtime.c always linked and nes.lib from the cc65 share tree.
import { runTool, shareFiles, type ToolLoader } from "./wasmtool.ts";
import type { BuildInput, BuildIssue, BuildResult } from "./toolchain.ts";

export type Cc65Tool = "cc65" | "ca65" | "ld65";

export interface NesRuntime {
  headers: Record<string, string>; // nes_runtime.h
  runtimeC: string; // nes_runtime.c
  crt0: string; // chr-ram-wram.crt0.s
  cfg: string; // chr-ram-wram.cfg
}

/** PRG-ROM the config gives code and data: $8000-$FFF9 (the vectors take the last 6 bytes). */
export const NES_PRG_SIZE = 0x7ffa;
// optimised like neslib projects (-O, inline, register variables, inline stdlib): unoptimised cc65 code misses frames
const CC_OPT = ["-Oirs"];
// romdev's warning set for C builds (valid cc65 -W names that catch real mistakes)
const CC_WARN = ["-W", "unused-var,unused-func,unused-label,const-comparison,struct-param,pointer-sign"];
// plain diagnostics: no ANSI colours or curly quotes in what the build reports
const PLAIN = ["--color", "off", "--no-utf8"];
// segments the config loads into PRG-ROM
const PRG_SEGMENTS = new Set(["STARTUP", "LOWCODE", "ONCE", "CODE", "RODATA", "DATA"]);

export class Cc65Toolchain {
  private loader: ToolLoader;
  private runtime: Promise<{ runtime: Uint8Array; crt0: Uint8Array }> | null = null;

  constructor(loader: ToolLoader) {
    this.loader = loader;
  }

  /** cc65: a C file to assembly text. */
  private async compile(name: string, source: string, headers: Record<string, string>) {
    const files: Record<string, Uint8Array | string> = {
      ...(await shareFiles(this.loader, "cc65", "include/", "/share/cc65/include/")),
      [`/work/${name}`]: source,
    };
    for (const [h, text] of Object.entries(headers)) files[`/work/${h}`] = text;
    const out = `/work/${name.replace(/\.c$/, ".s")}`;
    const r = await runTool(this.loader, "cc65", ["-t", "nes", ...CC_OPT, ...CC_WARN, "-I", "/share/cc65/include", "-I", "/work", "-o", out, `/work/${name}`], {
      files,
      outputs: [out],
    });
    return { asm: r.code === 0 ? r.outputs[out] : null, log: `--- cc65 (${name}) ---\n${r.log}` };
  }

  /** ca65: assembly text to an object file. `includes` are the other files a `.include` may name. */
  private async assemble(name: string, source: string, includes: Record<string, string>) {
    const files: Record<string, Uint8Array | string> = {
      ...(await shareFiles(this.loader, "cc65", "asminc/", "/share/cc65/asminc/")),
      [`/work/${name}`]: source,
    };
    for (const [n, text] of Object.entries(includes)) if (n !== name) files[`/work/${n}`] = text;
    const out = `/work/${name.replace(/\.(s|asm)$/i, "")}.o`;
    const r = await runTool(this.loader, "ca65", ["-t", "nes", ...PLAIN, "-I", "/share/cc65/asminc", "-I", "/work", "-o", out, `/work/${name}`], {
      files,
      binaries: [out],
    });
    return { obj: r.code === 0 ? r.binaries[out] : null, log: r.log ? `--- ca65 (${name}) ---\n${r.log}` : "" };
  }

  private runtimeObjects(rt: NesRuntime) {
    this.runtime ??= (async () => {
      const c = await this.compile("nes_runtime.c", rt.runtimeC, rt.headers);
      const runtime = c.asm && (await this.assemble("nes_runtime.s", c.asm, {})).obj;
      if (!runtime) throw new Error("bundled nes_runtime.c failed to build:\n" + c.log);
      const crt0 = await this.assemble("crt0.s", rt.crt0, {});
      if (!crt0.obj) throw new Error("bundled crt0 failed to assemble:\n" + crt0.log);
      return { runtime, crt0: crt0.obj };
    })();
    this.runtime.catch(() => (this.runtime = null));
    return this.runtime;
  }

  async build(input: BuildInput, rt: NesRuntime): Promise<BuildResult> {
    const t0 = performance.now();
    const done = (r: Omit<BuildResult, "ms">): BuildResult => ({ ...r, ms: Math.round(performance.now() - t0) });
    const fail = (stage: BuildResult["stage"], log: string, romBytesUsed = 0) =>
      done({ ok: false, stage, rom: null, romBytesUsed, issues: parseCc65Issues(log), log });
    let log = "";
    const headers = { ...rt.headers };
    const asmIncludes: Record<string, string> = {};
    for (const [n, text] of Object.entries(input.sources)) {
      if (n.endsWith(".h")) headers[n] = text;
      if (/\.(s|asm|inc)$/i.test(n)) asmIncludes[n] = text;
    }

    const objects: Record<string, Uint8Array> = {};
    for (const [name, text] of Object.entries(input.sources)) {
      if (name === "nes_runtime.c") continue; // always the bundled runtime
      if (name.endsWith(".c")) {
        const c = await this.compile(name, text, headers);
        log += c.log;
        if (c.asm == null) return fail("compile", log);
        const a = await this.assemble(name.replace(/\.c$/, ".s"), c.asm, asmIncludes);
        log += a.log;
        if (!a.obj) return fail("assemble", log);
        objects[name.replace(/\.c$/, ".o")] = a.obj;
      } else if (/\.(s|asm)$/i.test(name)) {
        const a = await this.assemble(name, text, asmIncludes);
        log += a.log;
        if (!a.obj) return fail("assemble", log);
        objects[name.replace(/\.(s|asm)$/i, "") + ".o"] = a.obj;
      }
    }
    if (!Object.keys(objects).length) {
      return done({ ok: false, stage: "compile", rom: null, romBytesUsed: 0, issues: [{ file: "main.c", line: null, severity: "error", message: "no .c or .s source" }], log });
    }

    const rtObjs = await this.runtimeObjects(rt);
    const files: Record<string, Uint8Array | string> = {
      ...(await shareFiles(this.loader, "cc65", "lib/", "/share/cc65/lib/")),
      "/work/nes.cfg": rt.cfg,
      "/work/crt0.o": rtObjs.crt0,
      "/work/nes_runtime.o": rtObjs.runtime,
    };
    for (const [n, obj] of Object.entries(objects)) files[`/work/${n}`] = obj;
    const link = await runTool(
      this.loader,
      "ld65",
      ["-C", "/work/nes.cfg", ...PLAIN, "-o", "/work/out.nes", "-m", "/work/out.map", "/work/crt0.o", "/work/nes_runtime.o",
        ...Object.keys(objects).map((n) => `/work/${n}`), "/share/cc65/lib/nes.lib"],
      { files, outputs: ["/work/out.map"], binaries: ["/work/out.nes"] },
    );
    log += `--- ld65 ---\n${link.log}`;
    const used = prgBytesUsed(link.outputs["/work/out.map"]);
    const rom = link.binaries["/work/out.nes"];
    if (link.code !== 0 || !rom) return fail(/overflow/i.test(link.log) ? "size" : "link", log, used);
    return done({ ok: true, stage: "done", rom, romBytesUsed: used, issues: parseCc65Issues(log), log });
  }
}

/** Bytes of PRG-ROM the linked segments take, from ld65's map (0 when it cannot be read). */
export function prgBytesUsed(map: string | null): number {
  if (!map) return 0;
  const list = map.split(/Segment list:/)[1];
  if (!list) return 0;
  let n = 0;
  for (const m of list.matchAll(/^(\w+)\s+[0-9A-F]{6}\s+[0-9A-F]{6}\s+([0-9A-F]{6})\s/gim)) if (PRG_SEGMENTS.has(m[1])) n += parseInt(m[2], 16);
  return n;
}

// cc65 / ca65: "main.c:12: Error: ..." (older: "main.c(12): ..."); ld65: "/work/nes.cfg:44: Warning: Segment 'BSS'
// overflows memory area 'RAM' by 471 bytes" and "<program>: Error: ..." (the WASM build names itself "this").
const DIAG = /^(?:\/work\/)?([\w.\-/]+)(?::(\d+)|\((\d+)\)):\s*(Error|Warning|Fatal)\b[^:]*:\s*(.*)$/i;
const LINK = /^[\w.]+:\s*(Error|Warning|Fatal)\b[^:]*:\s*(.*)$/i;
const ANSI = /\x1b\[[0-9;]*m/g;

export function parseCc65Issues(log: string): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const seen = new Set<string>();
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").trim();
    let issue: BuildIssue | null = null;
    let m = DIAG.exec(line);
    if (m && /\.cfg$/.test(m[1])) issue = { file: "link", line: null, severity: /overflow/i.test(m[5]) || !/warning/i.test(m[4]) ? "error" : "warning", message: m[5] };
    else if (m) issue = { file: m[1], line: Number(m[2] ?? m[3]), severity: /warning/i.test(m[4]) ? "warning" : "error", message: m[5] };
    else if ((m = LINK.exec(line))) issue = { file: "link", line: null, severity: /warning/i.test(m[1]) ? "warning" : "error", message: m[2] };
    else if (/^\[abort\]/.test(line)) issue = { file: "toolchain", line: null, severity: "error", message: line };
    if (!issue) continue;
    const key = `${issue.file}:${issue.line}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}
