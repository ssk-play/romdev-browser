// The headless service (dist/server.mjs): build a fixture over HTTP, run it with input, read memory and a PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { root, template } from "./helpers.mjs";

test("server builds and runs a GBC game over HTTP", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();

  const bad = await post("/build", { platform: "gbc", sources: { "main.c": "void main(void) { oops }" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.severity === "error" && i.line), JSON.stringify(bad.issues));

  const b = await post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") } });
  assert.ok(b.ok, b.log);
  const r = await post("/run", { platform: "gbc", rom: b.rom, frames: 240, input: [{ frame: 120, until: 126, buttons: ["start"] }],
    shots: [100, 240], every: 60, memory: [{ offset: 0x1000, length: 16 }], sram: true });
  assert.deepEqual(r.rows.map((x) => x.frame), [60, 100, 120, 180, 240]);
  assert.equal(r.rows[0].memory[0].length, 32);
  assert.equal(r.shots.length, 2);
  assert.equal(Buffer.from(r.shots[0].png, "base64").subarray(1, 4).toString(), "PNG");
  assert.notEqual(r.shots[0].png, r.shots[1].png, "Start should change the screen");
  assert.equal(Buffer.from(r.sram, "base64").length, 8192);
});
