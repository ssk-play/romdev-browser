import test from "node:test";
import assert from "node:assert/strict";
import { Toolchain, parseIssues } from "../src/toolchain.ts";
import { nodeLoader, runtimeFor, template } from "./helpers.mjs";

const tc = new Toolchain(nodeLoader());

for (const platform of ["gb", "gbc"]) {
  for (const name of ["hello_sprite", "platformer"]) {
    test(`${platform}/${name} builds a 32KB ROM with a valid header`, async () => {
      const r = await tc.build({ platform, sources: { "main.c": template(platform, name) }, title: name }, runtimeFor(platform));
      assert.equal(r.ok, true, r.log);
      assert.equal(r.rom.length, 0x8000);
      assert.equal(r.rom[0x143], platform === "gbc" ? 0xc0 : 0x00);
      let hc = 0;
      for (let i = 0x134; i <= 0x14c; i++) hc = (hc - r.rom[i] - 1) & 0xff;
      assert.equal(r.rom[0x14d], hc);
      assert.equal(r.rom[0x147], 0x03); // crt0 declares MBC1+RAM+BATTERY
    });
  }
}

test("compile errors come back as structured issues with file and line", async () => {
  const src = "#include \"gb_runtime.h\"\nvoid main(void) {\n  undefined_thing = 3;\n}\n";
  const r = await tc.build({ platform: "gb", sources: { "main.c": src } }, runtimeFor("gb"));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "compile");
  const err = r.issues.find((i) => i.severity === "error");
  assert.ok(err, r.log);
  assert.equal(err.file, "main.c");
  assert.equal(err.line, 3);
});

test("undefined functions fail at link", async () => {
  const src = "void nope(void);\nvoid main(void) { nope(); }\n";
  const r = await tc.build({ platform: "gb", sources: { "main.c": src } }, runtimeFor("gb"));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "link");
  assert.match(r.issues.map((i) => i.message).join("\n"), /nope/);
});

test("parseIssues handles syntax errors", () => {
  const issues = parseIssues("/work/main.c:7: syntax error: token -> '}' ; column 1\n");
  assert.deepEqual(issues, [{ file: "main.c", line: 7, severity: "error", message: "syntax error: token -> '}' ; column 1" }]);
});
