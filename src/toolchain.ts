// SDCC sm83 C → Game Boy ROM, entirely in MEMFS. Mirrors romdev's buildZ80C +
// GB project recipe (gb_crt0.s, _CODE=$0150, _DATA=$C200, rgbfix-equivalent header).
// Environment-agnostic: the caller supplies the glue factories + compiled wasm
// modules, so the same code runs in a Web Worker and in Node tests.
import { BANK, fixHeader, ihxToBin, ihxUsage, ROM_SIZE, romSizeFor } from "./rom.ts";
import type { Platform } from "./protocol.ts";
import { runTool, shareFiles, type ToolLoader } from "./wasmtool.ts";
import { verifyContract, sdccAllocations, checkAllocations, checkAssemblyAliases, checkLiteralWrites, contextAddress, checkContextSize, checkPointerAliases, type Allocation, type MemoryContract } from "./memory-contract.ts";

export type { EmscriptenFactory, ToolLoader } from "./wasmtool.ts";

export type ToolName = "mcpp" | "sdcc" | "sdasgb" | "sdld";

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
  /** When the input carried `objects`: every unit this build compiled or reused, for the host to keep. */
  objects?: Record<string, CompiledUnit>;
  /** With `objects`, after a link: every global symbol's linked address (banked ones as n << 16 | $4000-$7FFF). */
  symbols?: Record<string, number>;
}

/**
 * One compiled .c file: its object (.rel), compiler log, the assembly/debug records the memory contract reads, and the
 * assembler's symbol table (`sym`: every label, static ones too, with its area and offset; absent in older units).
 */
export interface CompiledUnit { rel: string; log: string; asm: string; adb: string | null; sym?: string | null }

export interface BuildInput {
  platform: Platform;
  sources: Record<string, string>; // "main.c" plus optional extra .c/.h
  title?: string;
  /** Supplied by the host after recognizing its pinned engine ABI, never by game-authored JSON. */
  memoryContract?: MemoryContract;
  /** Compiled units the host kept from earlier builds (a result's `objects`); passing it (even `{}`) asks for them back. */
  objects?: Record<string, CompiledUnit>;
}

const CODE_LOC = 0x0150;
const DATA_LOC = 0xc200; // above shadow_oam ($C100-$C19F)

/** Compiled units kept per Toolchain: a build recompiles only the .c files whose preprocessed text changed. */
const COMPILED_MAX = 64;
const isUnit = (u: unknown): u is CompiledUnit => {
  const v = u as CompiledUnit;
  return !!v && typeof v.rel === "string" && typeof v.log === "string" && typeof v.asm === "string" && (v.adb === null || typeof v.adb === "string");
};
async function sha256(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Toolchain {
  private runtimeRelCache = new Map<string, { runtime: string; crt0: string }>();
  private compiled = new Map<string, CompiledUnit>();
  private loader: ToolLoader;
  private cacheTag: string;

  /** `cacheTag` names this toolchain build (its version) in unit keys, so units from another one are never reused. */
  constructor(loader: ToolLoader, cacheTag = "") {
    this.loader = loader;
    this.cacheTag = cacheTag;
  }

  private run(tool: ToolName, argv: string[], opts: Parameters<typeof runTool>[3] = {}) {
    return runTool(this.loader, tool, argv, opts);
  }

  private shareFiles(prefix: string, mount: string) {
    return shareFiles(this.loader, "sdcc", prefix, mount);
  }

  /** mcpp → sdcc --c1mode → sdasgb. Returns .rel text or a failed RunResult log. */
  private async compileC(name: string, source: string, headers: Record<string, string>, records = false) {
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
    // sdcc and sdasgb are deterministic: the same preprocessed unit (its #line names included) under the same flags
    // and toolchain gives the same object, so an unchanged file is not compiled again
    const key = await sha256(`${this.cacheTag}\0${records ? "debug" : "plain"}\0${name}\0${cpp.outputs[out]}`);
    const hit = this.compiled.get(key);
    if (hit) {
      this.compiled.delete(key);
      this.compiled.set(key, hit);
      return { ...hit, key, cpp: cpp.outputs[out]! };
    }
    const assembly=`/work/${name.replace(/\.c$/,".asm")}`,debug=`/work/${name.replace(/\.c$/,".adb")}`;
    const cc = await this.run("sdcc", ["-msm83", ...(records?["--debug"]:[]), "--c1mode", "-o", assembly], {
      stdin: cpp.outputs[out]!,
      outputs: [assembly, ...(records?[debug]:[])],
    });
    const log = `--- sdcc (${name}) ---\n${cpp.log}${cc.log}`;
    if (cc.code !== 0 || !cc.outputs[assembly]) return { rel: null, log };
    const asm = await this.assemble(cc.outputs[assembly]!);
    const unit = { rel: asm.rel, log: log + asm.log, asm: cc.outputs[assembly]!, adb: cc.outputs[debug] ?? null, sym: asm.sym };
    if (unit.rel !== null) {
      this.compiled.set(key, unit as CompiledUnit);
      if (this.compiled.size > COMPILED_MAX) this.compiled.delete(this.compiled.keys().next().value!);
    }
    return { ...unit, key, cpp: cpp.outputs[out]! };
  }

  private async assemble(source: string) {
    // -w: the symbol table (main.sym) with whole names; the object is the same with or without it
    const r = await this.run("sdasgb", ["-plosgffw", "/work/main.rel", "/work/main.s"], {
      files: { "/work/main.s": source },
      outputs: ["/work/main.rel", "/work/main.sym"],
    });
    const ok = r.code === 0 && !!r.outputs["/work/main.rel"];
    return { rel: ok ? r.outputs["/work/main.rel"]! : null, sym: ok ? r.outputs["/work/main.sym"] ?? null : null, log: r.log ? `--- sdasgb ---\n${r.log}` : "" };
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
    const units = new Map<string, CompiledUnit>();
    const done = (r: Omit<BuildResult, "ms">): BuildResult =>
      ({ ...r, ...(input.objects ? { objects: Object.fromEntries(units) } : {}), ms: Math.round(performance.now() - t0) });
    for (const [k, u] of Object.entries(input.objects ?? {})) if (!this.compiled.has(k) && isUnit(u)) this.compiled.set(k, u);
    let log = "";
    const contract=input.memoryContract,allocations:Allocation[]=[],assemblies=new Map<string,string>(),preprocessed=new Map<string,string>();
    const memoryFailure=(e:unknown)=>done({ok:false,stage:"compile",rom:null,romBytesUsed:0,issues:[{file:"memory",line:null,severity:"error",message:String((e as Error).message??e)}],log});
    if(contract)try{await verifyContract(contract,input.sources);if(Object.keys(input.sources).some(n=>/\.(s|asm)$/i.test(n)))throw new Error("standalone sm83 assembly has no verifiable allocation records");}catch(e){return memoryFailure(e);}
    const headers = { ...rt.headers };
    for (const [n, text] of Object.entries(input.sources)) if (n.endsWith(".h")) headers[n] = text;

    const objects: Record<string, string> = {};
    for (const [name, text] of Object.entries(input.sources)) {
      if (!name.endsWith(".c")) continue;
      if (name === "gb_runtime.c") continue; // always the bundled runtime
      const r = await this.compileC(name, text, headers,!!contract);
      log += r.log;
      if (r.rel && "key" in r && r.key) units.set(r.key, { rel: r.rel, log: r.log, asm: r.asm!, adb: r.adb ?? null, sym: r.sym ?? null });
      if (!r.rel) return done({ ok: false, stage: "compile", rom: null, romBytesUsed: 0, issues: parseIssues(log), log });
      if(contract)try{
        const a=sdccAllocations(name,r.asm!,r.adb!);allocations.push(...a);assemblies.set(name,r.asm!);
        checkContextSize(contract,name,r.asm!,r.adb);
        if(!contract.engineFiles[name]){checkAssemblyAliases(name,r.asm!,input.platform,a);checkLiteralWrites(name,r.asm!,input.platform);preprocessed.set(name,r.cpp!);checkPointerAliases(name,r.cpp!,input.platform);}
        checkAllocations(input.platform,a,contract);
      }catch(e){return memoryFailure(e);}
      objects[name.replace(/\.c$/, ".rel")] = r.rel;
    }
    if (Object.keys(objects).length === 0) {
      return done({ ok: false, stage: "compile", rom: null, romBytesUsed: 0, issues: [{ file: "main.c", line: null, severity: "error", message: "no .c source" }], log });
    }
    // Switchable ROM banks: what a source places in area _CODE_<n> (n = 2-511: `#pragma constseg CODE_2` for data,
    // `#pragma codeseg CODE_2` for `__banked` code, called through crt0's ___sdcc_bcall_ehl; sdcc adds the underscore)
    // is linked at bank n's window ($4000) and written at n x 16 KB; the cart becomes MBC5. Code that switches banks
    // must sit in the first 16 KB, so the runtime is linked right after crt0 and sources keep the order they come in.
    const banks = new Set<number>();
    for (const [name, rel] of Object.entries(objects))
      for (const m of rel.matchAll(/^A _CODE_(\d+) size ([0-9A-Fa-f]+)/gm)) {
        if (!parseInt(m[2], 16)) continue;
        const bank = Number(m[1]);
        if (bank < 2 || bank > 511) {
          // MBC5 has 512 banks; romdev's sdasgb links with 32-bit addresses, so all of them link at n<<16 | $4000
          const message = bank < 2 ? `bank ${bank}: switchable banks start at 2 (banks 0 and 1 are the fixed 32 KB)` : `bank ${bank}: MBC5 has banks up to 511 (8 MB)`;
          return done({ ok: false, stage: "link", rom: null, romBytesUsed: 0, issues: [{ file: name.replace(/\.rel$/, ".c"), line: null, severity: "error", message }], log: log + message + "\n" });
        }
        banks.add(bank);
      }
    const rtObjs = await this.runtimeObjects(input.platform, rt);
    const share = await this.shareFiles("lib/sm83/", "/share/sdcc/lib/sm83/");
    const files: Record<string, Uint8Array | string> = {
      ...share,
      "/work/crt0.rel": rtObjs.crt0,
      "/work/gb_runtime.rel": rtObjs.runtime,
    };
    for (const [n, rel] of Object.entries(objects)) files[`/work/${n}`] = rel;
    // The C library modules the build uses (`*` `/` `%`, 32-bit math, struct copies, calls through function pointers)
    // link right after the runtime, before any source: sdld would put them after every source, past 16 KB in a big
    // game, where a `__banked` function (its bank at $4000-$7FFF) cannot reach them, even through fixed code it calls.
    const library = libraryModules(share["/share/sdcc/lib/sm83/sm83.lib"], [rtObjs.crt0, rtObjs.runtime, ...Object.values(objects)]);
    for (const m of library) files[`/work/lib/${m.name}`] = m.text;
    const link = await this.run(
      "sdld",
      [
        "-n", "-mjwx", "-i",
        "-b", `_CODE=0x${CODE_LOC.toString(16)}`,
        "-b", `_DATA=0x${DATA_LOC.toString(16)}`,
        ...[...banks].flatMap((b) => ["-b", `_CODE_${b}=0x${((b << 16) | BANK).toString(16)}`]),
        "-k", "/share/sdcc/lib/sm83",
        "/work/out.ihx", "/work/crt0.rel", "/work/gb_runtime.rel",
        ...library.map((m) => `/work/lib/${m.name}`),
        ...Object.keys(objects).map((n) => `/work/${n}`),
        "-l", "sm83.lib", "-e",
      ],
      { files, outputs: ["/work/out.ihx",...(contract || input.objects?["/work/out.map"]:[])] },
    );
    log += `--- sdld ---\n${link.log}`;
    const ihx = link.outputs["/work/out.ihx"];
    const linkIssues = parseIssues(link.log);
    if (link.code !== 0 || !ihx || linkIssues.some((i) => i.severity === "error")) {
      return done({ ok: false, stage: "link", rom: null, romBytesUsed: 0, issues: parseIssues(log), log });
    }
    if(contract)try{
      const address=contextAddress(link.outputs["/work/out.map"],contract,input.platform);checkAllocations(input.platform,allocations,contract,address);
      for(const [file,asm]of assemblies)if(!contract.engineFiles[file])checkLiteralWrites(file,asm,input.platform,address,contract.contextSymbol);
      for(const [file,cpp]of preprocessed)checkPointerAliases(file,cpp,input.platform,address);
    }catch(e){return memoryFailure(e);}
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
    const rom = fixHeader(ihxToBin(ihx, romSizeFor([...banks])), input.platform === "gbc" ? "gbc" : "gb", input.title, banks.size > 0);
    const symbols = input.objects ? mapSymbols(link.outputs["/work/out.map"] ?? "") : undefined;
    return done({ ok: true, stage: "done", rom, romBytesUsed: used, ...(banks.size ? { banks: usage.banks } : {}), ...(symbols ? { symbols } : {}), issues: parseIssues(log), log });
  }
}

/** The members of an `ar` archive (sdar writes GNU ar: "name/" or "/n" into the "//" long-name table). */
export function arMembers(lib: Uint8Array): { name: string; text: string }[] {
  const text = (a: number, b: number) => Array.from(lib.subarray(a, b), (c) => String.fromCharCode(c)).join("");
  if (text(0, 8) !== "!<arch>\n") return [];
  const out: { name: string; text: string }[] = [];
  let longNames = "";
  for (let p = 8; p + 60 <= lib.length;) {
    const raw = text(p, p + 16).trimEnd();
    const size = parseInt(text(p + 48, p + 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0 || p + 60 + size > lib.length) return [];
    const body = text(p + 60, p + 60 + size);
    if (raw === "//") longNames = body;
    else if (raw !== "/") {
      const long = /^\/(\d+)$/.exec(raw);
      const name = long ? longNames.slice(Number(long[1])).split(/\/?\n/)[0] : raw.replace(/\/$/, "");
      out.push({ name, text: body });
    }
    p += 60 + size + (size & 1);
  }
  return out;
}

type Member = { name: string; text: string; defs: string[]; refs: string[] };
const indexes = new WeakMap<Uint8Array, { members: Member[]; first: Map<string, Member> }>();
/** The archive's members with their symbols, and the first member defining each symbol (kept per archive). */
function libraryIndex(lib: Uint8Array) {
  let index = indexes.get(lib);
  if (!index) {
    const members = arMembers(lib).filter((m) => m.name.endsWith(".rel")).map((m) => ({ ...m, ...relSymbols(m.text) }));
    const first = new Map<string, Member>();
    for (const m of members) for (const d of m.defs) if (!first.has(d)) first.set(d, m);
    index = { members, first };
    indexes.set(lib, index);
  }
  return index;
}

const relSymbols = (rel: string) => {
  const defs: string[] = [], refs: string[] = [];
  for (const m of rel.matchAll(/^S (\S+) (Def|Ref)/gm)) if (m[1] !== ".__.ABS.") (m[2] === "Def" ? defs : refs).push(m[1]);
  return { defs, refs };
};

/**
 * The library members sdld would pull from `lib` for these objects (each symbol from the first member defining it, until
 * nothing more resolves), in archive order. A member whose code SDCC put in `_HOME` (32-bit and float math), linked
 * after all of `_CODE`, comes back with that area as its `_CODE`, so it links where it is placed.
 */
export function libraryModules(lib: Uint8Array | undefined, objects: string[]): { name: string; text: string }[] {
  const { members, first } = lib ? libraryIndex(lib) : { members: [], first: new Map<string, Member>() };
  const defined = new Set<string>();
  const wanted: string[] = [];
  for (const o of objects) {
    const { defs, refs } = relSymbols(o);
    defs.forEach((d) => defined.add(d));
    wanted.push(...refs);
  }
  const pulled = new Set<Member>();
  while (wanted.length) {
    const s = wanted.pop()!;
    const m = defined.has(s) ? undefined : first.get(s);
    if (!m || pulled.has(m)) continue;
    pulled.add(m);
    m.defs.forEach((d) => defined.add(d));
    wanted.push(...m.refs);
  }
  return members.filter((m) => pulled.has(m)).map((m) => ({ name: m.name, text: homeAsCode(m.text) }));
}

function homeAsCode(rel: string) {
  const size = (area: string) => parseInt(new RegExp(`^A ${area} size ([0-9A-Fa-f]+)`, "m").exec(rel)?.[1] ?? "0", 16);
  if (!size("_HOME") || size("_CODE")) return rel;
  return rel.replace(/^A (_CODE|_HOME) /gm, (_, a: string) => `A ${a === "_CODE" ? "_HOME" : "_CODE"} `);
}

/** Global symbols and their addresses from sdld's map (-mjwx: hex, wide). */
export function mapSymbols(map: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of map.matchAll(/^\s+(?:[0-9A-Fa-f]+:)?([0-9A-Fa-f]{8})\s+(\S+)/gm)) out[m[2]] = parseInt(m[1], 16);
  return out;
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
