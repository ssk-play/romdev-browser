// Node-side loader for the same public/wasm assets the browser fetches.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const root = path.resolve(import.meta.dirname, "..");
const wasmDir = path.join(root, "dist", "wasm");

export function nodeLoader() {
  const modules = new Map();
  let share = null;
  return {
    async factory(tool) {
      return (await import(pathToFileURL(path.join(wasmDir, `${tool}.mjs`)).href)).default;
    },
    async module(tool) {
      if (!modules.has(tool)) modules.set(tool, WebAssembly.compile(readFileSync(path.join(wasmDir, `${tool}.wasm`))));
      return modules.get(tool);
    },
    async share() {
      share ??= Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(path.join(wasmDir, "sdcc-share.json"), "utf8"))).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, "base64"))]),
      );
      return share;
    },
  };
}

export function runtimeFor(platform) {
  const dir = path.join(root, "vendor", "romdev", platform);
  const read = (f) => readFileSync(path.join(dir, f), "utf8");
  const headers = { "gb_hardware.h": read("gb_hardware.h"), "gb_runtime.h": read("gb_runtime.h"), "font.h": readFileSync(path.join(root, "vendor/romdev/gbc/font.h"), "utf8") };
  return { headers, runtimeC: read("gb_runtime.c"), crt0: read("gb_crt0.s") };
}

export function template(platform, name) {
  return readFileSync(path.join(root, "tests", "fixtures", platform, `${name}.c`), "utf8");
}
