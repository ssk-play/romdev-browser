// Builds dist/: the two workers (ES modules) and the WASM they load from ./wasm/.
//
// romdev's published emscripten glue is built with ENVIRONMENT=node only
// (ENVIRONMENT_IS_NODE hard-coded to true), so it tries to require('fs') on load.
// We flip that one flag: every tool is then driven purely through MEMFS with wasm
// bytes supplied by the caller — the bytes-only contract romdev-core-host documents.
// This is the only modification made to the GPL binaries' glue; see NOTICE.md.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const wasm = path.join(dist, "wasm");
rmSync(dist, { recursive: true, force: true });
mkdirSync(wasm, { recursive: true });
const pkgDir = (name) => path.join(root, "node_modules", name);
const pkgVersion = (name) => JSON.parse(readFileSync(path.join(pkgDir(name), "package.json"), "utf8")).version;

function patchGlue(src, dst) {
  const text = readFileSync(src, "utf8");
  const re = /var ENVIRONMENT_IS_NODE ?= ?true/g;
  const hits = text.match(re)?.length ?? 0;
  if (hits !== 1) throw new Error(`${src}: expected exactly one ENVIRONMENT_IS_NODE=true, found ${hits}`);
  writeFileSync(dst, text.replace(re, "var ENVIRONMENT_IS_NODE=false"));
}

const sdcc = pkgDir("romdev-toolchain-sdcc");
for (const t of ["mcpp", "sdcc", "sdasgb", "sdld"]) {
  patchGlue(path.join(sdcc, "wasm", `${t}.js`), path.join(wasm, `${t}.mjs`));
  copyFileSync(path.join(sdcc, "wasm", `${t}.wasm`), path.join(wasm, `${t}.wasm`));
}
const gambatte = pkgDir("romdev-core-gambatte");
patchGlue(path.join(gambatte, "wasm", "gambatte_libretro.js"), path.join(wasm, "gambatte.mjs"));
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
  sizes,
};
writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const f of ["LICENSE", "NOTICE.md"]) copyFileSync(path.join(root, f), path.join(dist, f));
console.log(`romdev-browser ${version}: dist/ built`, Object.keys(sizes).length, "wasm assets");
