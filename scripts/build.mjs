// Builds dist/: the two workers (ES modules) and the WASM they load from ./wasm/.
//
// The romdev-* packages resolve to the sibling romdev checkout (../romdev, see package.json), whose
// build recipes link the glue for node,web,worker. The glue and .wasm are copied unmodified; the
// build refuses node-only glue (emcc -s ENVIRONMENT=node hard-codes ENVIRONMENT_IS_NODE=true and
// the first thing such glue does is `await import("module")`, which no browser can satisfy).
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const wasm = path.join(dist, "wasm");
rmSync(dist, { recursive: true, force: true });
mkdirSync(wasm, { recursive: true });
const pkgDir = (name) => path.join(root, "node_modules", name);
const pkgVersion = (name) => JSON.parse(readFileSync(path.join(pkgDir(name), "package.json"), "utf8")).version;

function copyGlue(src, dst) {
  const text = readFileSync(src, "utf8");
  if (/\bENVIRONMENT_IS_NODE\s*=\s*true\b/.test(text) || /\bENVIRONMENT_IS_WEB\s*=\s*false\b/.test(text)) {
    throw new Error(
      `${realpathSync(src)} is node-only glue (built with -s ENVIRONMENT=node).\n` +
        "Rebuild it from a romdev checkout whose recipes link node,web,worker " +
        "(https://github.com/monteslu/romdev/pull/<see NOTICE.md>), e.g. build-image/build-wasm.sh build-gambatte.sh.",
    );
  }
  copyFileSync(src, dst);
}

const sdcc = pkgDir("romdev-toolchain-sdcc");
for (const t of ["mcpp", "sdcc", "sdasgb", "sdld"]) {
  copyGlue(path.join(sdcc, "wasm", `${t}.js`), path.join(wasm, `${t}.mjs`));
  copyFileSync(path.join(sdcc, "wasm", `${t}.wasm`), path.join(wasm, `${t}.wasm`));
}
const gambatte = pkgDir("romdev-core-gambatte");
copyGlue(path.join(gambatte, "wasm", "gambatte_libretro.js"), path.join(wasm, "gambatte.mjs"));
copyFileSync(path.join(gambatte, "wasm", "gambatte_libretro.wasm"), path.join(wasm, "gambatte.wasm"));

// SDCC share tree trimmed to what an sm83 build reads.
const share = path.join(sdcc, "share", "sdcc");
const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[path.relative(share, p).split(path.sep).join("/")] = readFileSync(p).toString("base64");
  }
};
for (const name of readdirSync(path.join(share, "include"))) {
  const p = path.join(share, "include", name);
  if (statSync(p).isFile()) files[`include/${name}`] = readFileSync(p).toString("base64");
}
walk(path.join(share, "include", "asm", "default"));
walk(path.join(share, "include", "asm", "sm83"));
walk(path.join(share, "lib", "sm83"));
writeFileSync(path.join(wasm, "sdcc-share.json"), JSON.stringify(files));

const sizes = Object.fromEntries(readdirSync(wasm).map((f) => [f, statSync(path.join(wasm, f)).size]));

// romdev-core-host lazily imports Node-only helpers and treats a failed import as
// "capability absent"; replace them with a module that throws on load.
const nodeOnly = {
  name: "romdev-node-only",
  setup(b) {
    const re = /^\.\/(io-node|framebuffer-png|LibretroGL|glOptionalDep|chafa-render)\.js$|^(pngjs|webgl-node|native-gles|@monteslu\/chafa-wasm|node:.*)$/;
    b.onResolve({ filter: re }, (args) => (args.importer.includes("romdev-core-host") ? { path: args.path, namespace: "node-only" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "node-only" }, () => ({ contents: 'throw new Error("node-only module");', loader: "js" }));
  },
};
await build({
  entryPoints: { "compiler.worker": "src/compiler.worker.ts", "emulator.worker": "src/emulator.worker.ts" },
  outdir: dist,
  bundle: true,
  format: "esm",
  splitting: false,
  target: "es2022",
  platform: "browser",
  minify: true,
  sourcemap: true,
  legalComments: "eof",
  loader: { ".c": "text", ".h": "text", ".s": "text" },
  define: { __ASSET_SIZES__: JSON.stringify(sizes) },
  plugins: [nodeOnly],
  logLevel: "warning",
});

// The headless service (src/server.ts) for Node: same toolchain + core, builtins stay external.
const serverOnly = {
  name: "romdev-server-optional",
  setup(b) {
    const re = /^\.\/(io-node|framebuffer-png|LibretroGL|glOptionalDep|chafa-render)\.js$|^(pngjs|webgl-node|native-gles|@monteslu\/chafa-wasm)$/;
    b.onResolve({ filter: re }, (args) => (args.importer.includes("romdev-core-host") ? { path: args.path, namespace: "node-only" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "node-only" }, () => ({ contents: 'throw new Error("optional module");', loader: "js" }));
  },
};
await build({
  entryPoints: { server: "src/server.ts" },
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  legalComments: "eof",
  loader: { ".c": "text", ".h": "text", ".s": "text" },
  define: { __VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version) },
  plugins: [serverOnly],
  logLevel: "warning",
});

function romdevCheckout() {
  const dir = realpathSync(pkgDir("romdev-toolchain-sdcc"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    const tracked = git("status", "--porcelain", "--untracked-files=no");
    return { repo: git("config", "--get", "remote.origin.url"), commit: git("rev-parse", "HEAD"), dirty: tracked.length > 0 };
  } catch {
    return { repo: null, commit: null, dirty: null, note: `not a git checkout: ${dir}` };
  }
}

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifest = {
  name: "romdev-browser",
  version,
  license: "GPL-2.0-only",
  source: "https://github.com/ssk-play/romdev-browser",
  components: {
    "romdev-toolchain-sdcc": pkgVersion("romdev-toolchain-sdcc"),
    "romdev-core-gambatte": pkgVersion("romdev-core-gambatte"),
    "romdev-core-host": pkgVersion("romdev-core-host"),
    romdev: readFileSync(path.join(root, "vendor", "romdev", "COMMIT"), "utf8").trim(),
  },
  // Which romdev tree the wasm + glue came from (the corresponding source for the GPL binaries).
  wasmSource: romdevCheckout(),
  sizes,
};
writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const f of ["LICENSE", "NOTICE.md"]) copyFileSync(path.join(root, f), path.join(dist, f));
console.log(`romdev-browser ${version}: dist/ built`, Object.keys(sizes).length, "wasm assets");
