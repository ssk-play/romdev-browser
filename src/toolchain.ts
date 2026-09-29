// SDCC sm83 C → Game Boy ROM, entirely in MEMFS. Mirrors romdev's buildZ80C +
// GB project recipe (gb_crt0.s, _CODE=$0150, _DATA=$C200, rgbfix-equivalent header).
// Environment-agnostic: the caller supplies the glue factories + compiled wasm
// modules, so the same code runs in a Web Worker and in Node tests.
import { BANK, fixHeader, ihxToBin, ihxUsage, ROM_SIZE, romSizeFor, type Platform } from "./rom.ts";

export type ToolName = "mcpp" | "sdcc" | "sdasgb" | "sdld";

type EmscriptenFS = {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
};
type EmscriptenModule = { FS: EmscriptenFS; callMain(argv: string[]): number };
export type EmscriptenFactory = (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

export interface ToolLoader {
  factory(tool: ToolName): Promise<EmscriptenFactory>;
  module(tool: ToolName): Promise<WebAssembly.Module>;
  /** SDCC share tree: "include/stdint.h", "lib/sm83/sm83.lib", ... */
  share(): Promise<Record<string, Uint8Array>>;
}

export interface PlatformRuntime {
  headers: Record<string, string>; // gb_hardware.h, gb_runtime.h, font.h
  runtimeC: string; // gb_runtime.c
  crt0: string; // gb_crt0.s
}

export interface BuildIssue {
  file: string;
  line: number | null;
  severity: "error" | "warning";
  message: string;
}

export interface BuildResult {
  ok: boolean;
  stage: "compile" | "assemble" | "link" | "size" | "done";
  rom: Uint8Array | null;
  romBytesUsed: number;
  /** bytes used in each switchable bank (n >= 2), when the game has any */
  banks?: Record<number, number>;
  issues: BuildIssue[];
  log: string;
  ms: number;
}

export interface BuildInput {
  platform: Platform;
  sources: Record<string, string>; // "main.c" plus optional extra .c/.h
  title?: string;
}

const CODE_LOC = 0x0150;
const DATA_LOC = 0xc200; // above shadow_oam ($C100-$C19F)

const enc = new TextEncoder();
const dec = new TextDecoder();

interface RunResult {
  code: number;
  log: string;
  outputs: Record<string, string | null>;
}

export class Toolchain {
  private runtimeRelCache = new Map<string, { runtime: string; crt0: string }>();
  private loader: ToolLoader;

  constructor(loader: ToolLoader) {
    this.loader = loader;
  }

  private async run(
    tool: ToolName,
    argv: string[],
    opts: { files?: Record<string, Uint8Array | string>; stdin?: string; outputs?: string[] } = {},
  ): Promise<RunResult> {
    const [factory, wasmModule] = await Promise.all([this.loader.factory(tool), this.loader.module(tool)]);
    let log = "";
    let exitStatus: number | null = null;
    const stdinBytes = opts.stdin != null ? enc.encode(opts.stdin) : null;
    let stdinPos = 0;
    const mod = await factory({
      noInitialRun: true,
      print: (s: string) => (log += s + "\n"),
      printErr: (s: string) => (log += s + "\n"),
      quit: (status: number, toThrow?: unknown) => {
        exitStatus = status;
        throw toThrow ?? new Error("exit " + status);
      },
      onExit: (status: number) => (exitStatus = status),
      // Reuse the compiled module; each run gets a fresh instance + MEMFS.
      instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule));
        return {};
      },
      ...(stdinBytes ? { stdin: () => (stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : null) } : {}),
    });
    const mkdirp = (dir: string) => {
      let cur = "";
      for (const part of dir.split("/").filter(Boolean)) {
        cur += "/" + part;
        try {
          mod.FS.mkdir(cur);
        } catch {
          /* exists */
        }
      }
    };
    mkdirp("/work");
    for (const [p, data] of Object.entries(opts.files ?? {})) {
      mkdirp(p.slice(0, p.lastIndexOf("/")));
      mod.FS.writeFile(p, typeof data === "string" ? enc.encode(data) : data);
    }
    // Under Node the glue's quit handler also sets process.exitCode (the same leak romdev's
    // wasm-worker guards against); keep a tool's exit status from becoming the host's.
    const proc = (globalThis as { process?: { exitCode?: number | string } }).process;
    const hostExitCode = proc?.exitCode;
    let code = 0;
    try {
      code = mod.callMain(argv) ?? 0;
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (typeof status === "number") code = status;
      else if (exitStatus !== null) code = exitStatus;
      else {
        code = 1;
        log += `\n[abort] ${(e as Error)?.message ?? e}\n`;
      }
    }
    if (exitStatus !== null && code === 0) code = exitStatus;
    if (proc && proc.exitCode !== hostExitCode) {
      if (code === 0 && proc.exitCode) code = Number(proc.exitCode);
      proc.exitCode = hostExitCode;
    }
    const outputs: Record<string, string | null> = {};
    for (const p of opts.outputs ?? []) {
      try {
        outputs[p] = dec.decode(mod.FS.readFile(p));
      } catch {
        outputs[p] = null;
      }
    }
    return { code, log, outputs };
  }

  private async shareFiles(prefix: string, mount: string): Promise<Record<string, Uint8Array>> {
    const share = await this.loader.share();
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(share)) if (k.startsWith(prefix)) files[mount + k.slice(prefix.length)] = v;
    return files;
  }

  /** mcpp → sdcc --c1mode → sdasgb. Returns .rel text or a failed RunResult log. */
  private async compileC(name: string, source: string, headers: Record<string, string>) {
    const files: Record<string, Uint8Array | string> = {
      ...(await this.shareFiles("include/", "/share/sdcc/include/")),
      [`/work/${name}`]: source,
    };
    for (const [h, text] of Object.entries(headers)) files[`/work/${h}`] = text;
    const out = `/work/${name.replace(/\.c$/, ".i")}`;
    const cpp = await this.run(
      "mcpp",
      ["-I", "/share/sdcc/include", "-I", "/work", "-D__SDCC", "-D__SDCC_sm83", `/work/${name}`, out],
      { files, outputs: [out] },
    );
    if (cpp.code !== 0 || !cpp.outputs[out]) return { rel: null, log: `--- mcpp (${name}) ---\n${cpp.log}` };
    const cc = await this.run("sdcc", ["-msm83", "--c1mode", "-o", "/work/main.asm"], {
      stdin: cpp.outputs[out]!,
      outputs: ["/work/main.asm"],
    });
    const log = `--- sdcc (${name}) ---\n${cpp.log}${cc.log}`;
    if (cc.code !== 0 || !cc.outputs["/work/main.asm"]) return { rel: null, log };
    const asm = await this.assemble(cc.outputs["/work/main.asm"]!);
    return { rel: asm.rel, log: log + asm.log };
  }

  private async assemble(source: string) {
    const r = await this.run("sdasgb", ["-plosgff", "/work/main.rel", "/work/main.s"], {
      files: { "/work/main.s": source },
      outputs: ["/work/main.rel"],
    });
    const ok = r.code === 0 && !!r.outputs["/work/main.rel"];
    return { rel: ok ? r.outputs["/work/main.rel"]! : null, log: r.log ? `--- sdasgb ---\n${r.log}` : "" };
  }

  private async runtimeObjects(platform: Platform, rt: PlatformRuntime) {
    const cached = this.runtimeRelCache.get(platform);
    if (cached) return cached;
    const runtime = await this.compileC("gb_runtime.c", rt.runtimeC, rt.headers);
    if (!runtime.rel) throw new Error("bundled gb_runtime.c failed to compile:\n" + runtime.log);
    const crt0 = await this.assemble(rt.crt0);
    if (!crt0.rel) throw new Error("bundled gb_crt0.s failed to assemble:\n" + crt0.log);
    const entry = { runtime: runtime.rel, crt0: crt0.rel };
    this.runtimeRelCache.set(platform, entry);
    return entry;
  }

  async build(input: BuildInput, rt: PlatformRuntime): Promise<BuildResult> {
    const t0 = performance.now();
    const done = (r: Omit<BuildResult, "ms">): BuildResult => ({ ...r, ms: Math.round(performance.now() - t0) });
    let log = "";
    const headers = { ...rt.headers };
    for (const [n, text] of Object.entries(input.sources)) if (n.endsWith(".h")) headers[n] = text;

    const objects: Record<string, string> = {};
    for (const [name, text] of Object.entries(input.sources)) {
      if (!name.endsWith(".c")) continue;
      if (name === "gb_runtime.c") continue; // always the bundled runtime
      const r = await this.compileC(name, text, headers);
      log += r.log;
      if (!r.rel) return done({ ok: false, stage: "compile", rom: null, romBytesUsed: 0, issues: parseIssues(log), log });
      objects[name.replace(/\.c$/, ".rel")] = r.rel;
    }
    if (Object.keys(objects).length === 0) {
      return done({ ok: false, stage: "compile", rom: null, romBytesUsed: 0, issues: [{ file: "main.c", line: null, severity: "error", message: "no .c source" }], log });
    }
    // Switchable ROM banks: what a source places in area _CODE_<n> (n >= 2: `#pragma constseg CODE_2`, sdcc adds the underscore) is linked
    // at bank n's window ($4000) and written at n x 16 KB; the cart becomes MBC5. Code that switches banks must sit in
    // the first 16 KB, so the runtime is linked right after crt0 and sources keep the order they come in.
    const banks = new Set<number>();
    for (const [name, rel] of Object.entries(objects))
      for (const m of rel.matchAll(/^A _CODE_(\d+) size ([0-9A-Fa-f]+)/gm)) {
        if (!parseInt(m[2], 16)) continue;
        const bank = Number(m[1]);
        if (bank < 2 || bank > 255) {
          // sdld addresses are 24-bit: bank n links at n<<16 | $4000, so 256 and up would wrap onto 0-255
          const message = bank < 2 ? `bank ${bank}: switchable banks start at 2 (banks 0 and 1 are the fixed 32 KB)` : `bank ${bank}: the last bank is 255 (4 MB)`;
          return done({ ok: false, stage: "link", rom: null, romBytesUsed: 0, issues: [{ file: name.replace(/\.rel$/, ".c"), line: null, severity: "error", message }], log: log + message + "\n" });
        }
        banks.add(bank);
      }
    const rtObjs = await this.runtimeObjects(input.platform, rt);
    const files: Record<string, Uint8Array | string> = {
      ...(await this.shareFiles("lib/sm83/", "/share/sdcc/lib/sm83/")),
      "/work/crt0.rel": rtObjs.crt0,
      "/work/gb_runtime.rel": rtObjs.runtime,
    };
    for (const [n, rel] of Object.entries(objects)) files[`/work/${n}`] = rel;
    const link = await this.run(
      "sdld",
      [
        "-n", "-mjwx", "-i",
        "-b", `_CODE=0x${CODE_LOC.toString(16)}`,
        "-b", `_DATA=0x${DATA_LOC.toString(16)}`,
        ...[...banks].flatMap((b) => ["-b", `_CODE_${b}=0x${((b << 16) | BANK).toString(16)}`]),
        "-k", "/share/sdcc/lib/sm83",
        "/work/out.ihx", "/work/crt0.rel", "/work/gb_runtime.rel",
        ...Object.keys(objects).map((n) => `/work/${n}`),
        "-l", "sm83.lib", "-e",
      ],
      { files, outputs: ["/work/out.ihx"] },
    );
    log += `--- sdld ---\n${link.log}`;
    const ihx = link.outputs["/work/out.ihx"];
    const linkIssues = parseIssues(link.log);
    if (link.code !== 0 || !ihx || linkIssues.some((i) => i.severity === "error")) {
      return done({ ok: false, stage: "link", rom: null, romBytesUsed: 0, issues: parseIssues(log), log });
    }
    const usage = ihxUsage(ihx);
    const used = usage.fixed + Object.values(usage.banks).reduce((a, b) => a + b, 0);
    const over = [
      usage.fixed > ROM_SIZE && `the fixed ROM (code and data outside banks) is ${usage.fixed} bytes; it holds ${ROM_SIZE}. Move big data into a bank or shrink it.`,
      ...Object.entries(usage.banks).filter(([, n]) => n > BANK).map(([b, n]) => `bank ${b} is ${n} bytes; a bank holds ${BANK}. Spread the data over more banks.`),
    ].filter((m): m is string => !!m);
    if (over.length) {
      const issues = over.map((message) => ({ file: "link", line: null, severity: "error" as const, message }));
      return done({ ok: false, stage: "size", rom: null, romBytesUsed: used, banks: usage.banks, issues, log: log + over.join("\n") + "\n" });
    }
    const rom = fixHeader(ihxToBin(ihx, romSizeFor([...banks])), input.platform, input.title, banks.size > 0);
    return done({ ok: true, stage: "done", rom, romBytesUsed: used, ...(banks.size ? { banks: usage.banks } : {}), issues: parseIssues(log), log });
  }
}

const DIAG = /^(?:\/work\/)?([\w.\-/]+):(\d+):\s*(error|warning)\b[^:]*:\s*(.*)$/i;
// sdcc's syntax errors come as "main.c:12: syntax error: token -> 'x' ; column 5"
const SYNTAX = /^(?:\/work\/)?([\w.\-/]+):(\d+):\s*(syntax error.*)$/i;

export function parseIssues(log: string): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const seen = new Set<string>();
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    let issue: BuildIssue | null = null;
    let m = DIAG.exec(line);
    if (m) issue = { file: m[1], line: Number(m[2]), severity: m[3].toLowerCase() as "error" | "warning", message: m[4] };
    else if ((m = SYNTAX.exec(line))) issue = { file: m[1], line: Number(m[2]), severity: "error", message: m[3] };
    else if (/ASlink-(Warning|Error)/.test(line)) {
      // Undefined globals are fatal for us even though sdld calls them warnings.
      const severity = /Error|Undefined Global/.test(line) ? "error" : "warning";
      issue = { file: "link", line: null, severity, message: line.replace(/^\?/, "") };
    } else if (/^\[abort\]/.test(line)) issue = { file: "toolchain", line: null, severity: "error", message: line };
    if (!issue) continue;
    const key = `${issue.file}:${issue.line}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}
