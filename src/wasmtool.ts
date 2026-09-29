// Runs one command-line tool built to WebAssembly (an Emscripten module) in a fresh instance with its own MEMFS.
// Environment-agnostic: the caller's loader supplies the glue factories and compiled modules, so the same code runs
// in a Web Worker and in Node. Shared by every toolchain (SDCC, cc65).

type EmscriptenFS = {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
};
type EmscriptenModule = { FS: EmscriptenFS; callMain(argv: string[]): number };
export type EmscriptenFactory = (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

/** A toolchain's files that its tools read (headers, libraries, configs), keyed by path inside the tree. */
export type ShareName = "sdcc" | "cc65";

export interface ToolLoader {
  factory(tool: string): Promise<EmscriptenFactory>;
  module(tool: string): Promise<WebAssembly.Module>;
  /** A share tree: "include/stdint.h", "lib/sm83/sm83.lib", ... */
  share(name: ShareName): Promise<Record<string, Uint8Array>>;
}

export interface RunResult {
  code: number;
  log: string;
  /** requested text outputs (null when the tool did not write them) */
  outputs: Record<string, string | null>;
  /** requested binary outputs */
  binaries: Record<string, Uint8Array | null>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function runTool(
  loader: ToolLoader,
  tool: string,
  argv: string[],
  opts: { files?: Record<string, Uint8Array | string>; stdin?: string; outputs?: string[]; binaries?: string[] } = {},
): Promise<RunResult> {
  const [factory, wasmModule] = await Promise.all([loader.factory(tool), loader.module(tool)]);
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
  const read = (p: string) => {
    try {
      return mod.FS.readFile(p);
    } catch {
      return null;
    }
  };
  const outputs: Record<string, string | null> = {};
  for (const p of opts.outputs ?? []) {
    const b = read(p);
    outputs[p] = b ? dec.decode(b) : null;
  }
  const binaries: Record<string, Uint8Array | null> = {};
  for (const p of opts.binaries ?? []) {
    const b = read(p);
    binaries[p] = b ? Uint8Array.from(b) : null;
  }
  return { code, log, outputs, binaries };
}

/** The files of a share tree under `prefix`, mounted at `mount`. */
export async function shareFiles(loader: ToolLoader, name: ShareName, prefix: string, mount: string): Promise<Record<string, Uint8Array>> {
  const share = await loader.share(name);
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(share)) if (k.startsWith(prefix)) files[mount + k.slice(prefix.length)] = v;
  return files;
}
