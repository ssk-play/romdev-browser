import type { Platform } from "./protocol.ts";
import { contextLocation } from "./multiplayer-abi.ts";
export interface MemoryContract {
  abi: 1;
  engineFiles: Record<string, string>;
  contextSymbol: string;
}
export interface Allocation {
  file: string;
  symbol: string;
  address: number;
  size: number;
}
const hex = (bytes: Uint8Array) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
const ram = (p: Platform, a: number) =>
  p === "nes"
    ? a < 0x2000 || (a >= 0x6000 && a < 0x8000)
    : (a >= 0xc000 && a < 0xfe00) || (a >= 0xff80 && a < 0xffff);
const physical = (p: Platform, a: number) =>
  p === "nes" && a < 0x2000 ? a & 0x7ff : p !== "nes" && a >= 0xe000 && a < 0xfe00 ? a - 0x2000 : a;
export async function verifyContract(c: MemoryContract, sources: Record<string, string>) {
  if (
    !c ||
    c.abi !== 1 ||
    !c.engineFiles ||
    Array.isArray(c.engineFiles) ||
    !c.engineFiles["engine.c"] ||
    Object.keys(c.engineFiles).length > 3 ||
    typeof c.contextSymbol !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.contextSymbol)
  )
    throw new Error("invalid MP memory contract");
  for (const [file, hash] of Object.entries(c.engineFiles)) {
    if (
      !/^engine\.(c|h|s)$/.test(file) ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      typeof sources[file] !== "string"
    )
      throw new Error("invalid MP engine identity");
    const actual = hex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sources[file])),
      ),
    );
    if (actual !== hash) throw new Error(`${file}: engine identity mismatch`);
  }
}
/** SDCC's existing .adb gives complete object sizes; its generated assembly gives folded absolute addresses. */
export function sdccAllocations(file: string, asm: string, adb: string | null): Allocation[] {
  if (!adb) throw new Error(`${file}: missing compiler allocation records`);
  const sizes = new Map<string, number>();
  for (const m of adb.matchAll(/^S:([^\r\n(]+)\(\{(\d+)\}/gm)) sizes.set(m[1], Number(m[2]));
  const out: Allocation[] = [];
  for (const m of asm.matchAll(/^\s*([^\s=]+)\s*==\s*0x([a-f0-9]+)\s*$/gim)) {
    const size = sizes.get(m[1]);
    if (size === undefined || !Number.isInteger(size) || size < 1 || size > 65536)
      throw new Error(`${file}: unverifiable absolute object ${m[1]}`);
    out.push({ file, symbol: m[1], address: parseInt(m[2], 16), size });
  }
  return out;
}
/** Unsupported raw absolute aliases/origins fail closed; they must not bypass typed compiler records. */
export function checkAssemblyAliases(
  file: string,
  asm: string,
  p: Platform,
  typed: readonly Allocation[],
) {
  const known = new Set(
    typed.map((a) => {
      const parts = a.symbol.split("$");
      return `${a.address}/_${parts[parts[0] === "G" ? 1 : 2]}`;
    }),
  );
  for (const line of asm.split("\n")) {
    const s = line.split(";")[0];
    const org = /^\s*\.org\s+(.+)/i.exec(s);
    if (org) {
      const value = /^(?:0x|\$)([a-f0-9]+)\s*$/i.exec(org[1]);
      if (!value || ram(p, parseInt(value[1], 16)))
        throw new Error(`${file}: unverifiable absolute assembly origin`);
    }
    const alias = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|:=)\s*(?:0x|\$)([a-f0-9]+)\s*$/i.exec(s);
    if (alias) {
      const a = parseInt(alias[2], 16);
      if (ram(p, a) && !known.has(`${a}/${alias[1]}`))
        throw new Error(`${file}: unverifiable absolute assembly alias`);
    }
    const assignment = /^\s*([A-Za-z_$][\w$]*)\s*(?:=(?!=)|:=)\s*(.+)/.exec(s);
    if (assignment && !alias && assignment[2].trim() !== ".") {
      const decimal = /^\d+\s*$/.test(assignment[2]);
      if (!decimal || ram(p, Number(assignment[2])))
        throw new Error(`${file}: unsupported absolute assembly expression`);
    }
    if (/^\s*(?:[A-Za-z_$][\w$]*\s+)?\.(?:equ|set|define)\b/i.test(s))
      throw new Error(`${file}: unsupported absolute assembly definition`);
  }
}
export function checkContextSize(
  c: MemoryContract,
  file: string,
  asm: string,
  adb?: string | null,
) {
  if (!c.engineFiles[file] || file !== "engine.c") return false;
  const size = adb
    ? new RegExp(`^S:G\\$${c.contextSymbol}\\$[^\\r\\n(]*\\(\\{(\\d+)\\}`, "m").exec(adb)?.[1]
    : new RegExp(`^_${c.contextSymbol}:\\s*\\r?\\n\\s*\\.res\\s+(\\d+)(?:,|\\s|$)`, "m").exec(
        asm,
      )?.[1];
  if (Number(size) !== 32)
    throw new Error("engine MP context must have a verified 32-byte allocation record");
  return true;
}
export function checkAllocations(
  p: Platform,
  all: readonly Allocation[],
  c: MemoryContract,
  context?: number,
) {
  const header = p === "nes" ? 0x3f0 : 0xd0f0;
  for (const a of all) {
    if (c.engineFiles[a.file]) continue;
    if (
      !Number.isInteger(a.address) ||
      a.address < 0 ||
      a.address > 0xffff ||
      a.size < 1 ||
      a.address + a.size > 0x10000
    )
      throw new Error(`${a.file}: unsupported absolute allocation ${a.symbol}`);
    for (let i = 0; i < a.size; i++) {
      const address = physical(p, a.address + i);
      if (
        (address >= header && address < header + 16) ||
        (context !== undefined && address >= context && address < context + 32)
      )
        throw new Error(
          `${a.file}: ${a.symbol} overlaps engine-reserved RAM at $${address.toString(16).toUpperCase()}`,
        );
    }
  }
}
export function contextAddress(map: string | null, c: MemoryContract, p: Platform) {
  if (!map) throw new Error("missing linker allocation map");
  const name = "_" + c.contextSymbol;
  const addressFirst = new RegExp(`(?:^|\\s)([a-f0-9]{6,8})\\s+${name}(?=\\s|$)`, "im").exec(map);
  const symbolFirst = new RegExp(`(?:^|\\s)${name}\\s+([a-f0-9]{6,8})(?=\\s|$)`, "im").exec(map);
  const address = parseInt((addressFirst ?? symbolFirst)?.[1] ?? "", 16);
  if (!contextLocation(p, address)) {
    throw new Error(
      "MP context symbol must resolve to ordinary writable RAM outside the state page",
    );
  }
  return address;
}
/** Folded literal writes are identifiable; computed indirect writes remain an authoring rule, not a sandbox. */
export function checkLiteralWrites(
  file: string,
  asm: string,
  p: Platform,
  context?: number,
  contextSymbol?: string,
) {
  const header = p === "nes" ? 0x3f0 : 0xd0f0;
  const addressOf = (operand: string): number | null => {
    let expression = operand
      .trim()
      .replace(/^(?:#|[az]:)\s*/i, "")
      .replace(/\$([a-f0-9]+)/gi, "0x$1");
    if (context !== undefined && contextSymbol) {
      expression = expression.replace(new RegExp(`_${contextSymbol}\\b`, "g"), String(context));
    }
    if (!/^(?:0x[a-f0-9]+|\d|\()/i.test(expression)) return null;
    const tokens = expression.match(/0x[a-f0-9]+[uUlL]*|\d+[uUlL]*|<<|>>|[()+\-*\/%&|^~]/gi) ?? [];
    if (tokens.join("") !== expression.replace(/\s/g, "")) return null;
    try {
      return constant(expression);
    } catch {
      throw new Error(`${file}: unverifiable literal memory write`);
    }
  };
  const check = (address: number | null, width = 1) => {
    if (address === null) return;
    for (let i = 0; i < width; i++) {
      const a = physical(p, address + i);
      if (
        (a >= header && a < header + 16) ||
        (context !== undefined && a >= context && a < context + 32)
      ) {
        throw new Error(
          `${file}: literal write to engine-reserved RAM at $${a.toString(16).toUpperCase()}`,
        );
      }
    }
  };
  let hl: number | null = null;
  for (const line of asm.split("\n")) {
    const code = line.split(";")[0].trim();
    if (p === "nes") {
      // ca65 a:/z: only select addressing width. They do not change ownership.
      const store = /^(?:sta|stx|sty|inc|dec)\s+([^,]+)(?:,|$)/i.exec(code);
      if (store) check(addressOf(store[1]));
      continue;
    }
    const store = /^(?:ld|ldi|ldd)\s+\(\s*([^)]*)\s*\)\s*,\s*(.*)$/i.exec(code);
    if (store) {
      const indirect = /^hl([+-]?)$/i.exec(store[1].trim());
      if (indirect) {
        check(hl);
        if (hl !== null && (indirect[1] || /^ld[di]\b/i.test(code))) {
          hl += indirect[1] === "-" || /^ldd\b/i.test(code) ? -1 : 1;
        }
      } else check(addressOf(store[1]), /^sp$/i.test(store[2].trim()) ? 2 : 1);
    }
    const load = /^ld\s+hl\s*,\s*(.+)$/i.exec(code);
    if (load) hl = addressOf(load[1]);
    else if (/^(?:inc|dec)\s+hl$/i.test(code)) {
      if (hl !== null) hl += /^inc/i.test(code) ? 1 : -1;
    } else if (
      /^(?:ld\s+[hl]\s*,|(?:inc|dec)\s+[hl]$|pop\s+hl\b|add\s+hl\b|ldhl\b|call\b|ret\b|reti\b|jp\b|jr\b)|^[\w.$]+:/i.test(
        code,
      )
    ) {
      // Track only a statically known straight-line pointer. Unknown register
      // updates and control-flow merges invalidate it rather than guessing.
      hl = null;
    }
  }
}
// A small constant-expression parser, never eval/Function on author-supplied code.
function constant(text: string): number {
  const tokens = text.match(/0x[a-f0-9]+[uUlL]*|\d+[uUlL]*|<<|>>|[()+\-*\/%&|^~]/gi) ?? [];
  if (tokens.join("") !== text.replace(/\s/g, ""))
    throw new Error("unsupported constant pointer expression");
  let index = 0;
  const precedence: Record<string, number> = {
    "|": 1,
    "^": 2,
    "&": 3,
    "<<": 4,
    ">>": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
    "%": 6,
  };
  const atom = (): number => {
    const t = tokens[index++];
    if (t === "(") {
      const n = expression(1);
      if (tokens[index++] !== ")") throw new Error("unbalanced pointer expression");
      return n;
    }
    if (t === "+" || t === "-" || t === "~") {
      const n = atom();
      return t === "+" ? n : t === "-" ? -n : ~n;
    }
    if (!t || !/^\d/.test(t)) throw new Error("invalid pointer expression");
    const literal = t.replace(/[uUlL]+$/, "");
    return /^0[0-7]+$/.test(literal) ? parseInt(literal, 8) : Number(literal);
  };
  const expression = (minimum: number): number => {
    let left = atom();
    while ((precedence[tokens[index]] ?? 0) >= minimum) {
      const op = tokens[index++],
        right = expression(precedence[op] + 1);
      switch (op) {
        case "+":
          left += right;
          break;
        case "-":
          left -= right;
          break;
        case "*":
          left *= right;
          break;
        case "/":
          left = Math.trunc(left / right);
          break;
        case "%":
          left %= right;
          break;
        case "&":
          left &= right;
          break;
        case "|":
          left |= right;
          break;
        case "^":
          left ^= right;
          break;
        case "<<":
          left <<= right;
          break;
        case ">>":
          left >>= right;
          break;
      }
    }
    return left;
  };
  const result = expression(1);
  if (index !== tokens.length || !Number.isInteger(result) || result < 0 || result > 0xffff)
    throw new Error("unsupported pointer address");
  return result;
}
/** Preprocessed, typed literal pointer aliases supplement records on cc65 (which has no __at objects). */
export function checkPointerAliases(file: string, cpp: string, p: Platform, context?: number) {
  cpp = cpp.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (s) =>
    s.replace(/[^\n]/g, " "),
  );
  const aliases =
    /\(\s*((?:(?:const|volatile|signed|unsigned)\s+)*(?:(?:struct|union|enum)\s+)?[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*)\s*\*\s*\)\s*/g;
  for (const m of cpp.matchAll(aliases)) {
    let at = m.index! + m[0].length,
      end = at;
    if (cpp[at] === "(") {
      let depth = 0;
      do {
        if (cpp[end] === "(") depth++;
        if (cpp[end] === ")") depth--;
        end++;
      } while (depth && end < cpp.length);
    } else {
      const literal = /^(?:0x[a-f0-9]+|\d+)[uUlL]*/i.exec(cpp.slice(at));
      if (!literal) continue;
      end += literal[0].length;
    }
    const expression = cpp.slice(at, end),
      tokens = expression.match(/0x[a-f0-9]+[uUlL]*|\d+[uUlL]*|<<|>>|[()+\-*\/%&|^~]/gi) ?? [];
    if (tokens.join("") !== expression.replace(/\s/g, "")) continue; // A computed pointer is not statically provable.
    const type = m[1].replace(/\b(const|volatile|signed|unsigned)\b/g, "").trim();
    const size = ["long", "u32", "uint32_t"].includes(type)
      ? 4
      : ["short", "int", "u16", "uint16_t"].includes(type)
        ? 2
        : ["char", "u8", "uint8_t"].includes(type)
          ? 1
          : 0;
    if (!size) throw new Error(`${file}: unverifiable absolute pointer type`);
    let address = constant(expression);
    let cursor = end;
    for (let n = 0; n < 64; n++) {
      const op = /^\s*\)*\s*([+-])\s*/.exec(cpp.slice(cursor));
      if (!op) break;
      const start = cursor + op[0].length;
      let finish = start;
      if (cpp[start] === "(") {
        let depth = 0;
        do {
          if (cpp[finish] === "(") depth++;
          if (cpp[finish] === ")") depth--;
          finish++;
        } while (depth && finish < cpp.length);
      } else {
        const literal = /^(?:0x[a-f0-9]+|\d+)[uUlL]*/i.exec(cpp.slice(start));
        if (!literal) break;
        finish += literal[0].length;
      }
      address += (op[1] === "+" ? 1 : -1) * constant(cpp.slice(start, finish)) * size;
      cursor = finish;
    }
    const index = /^\s*\)*\s*\[([^\]]+)\]/.exec(cpp.slice(cursor));
    if (index) {
      const parts = index[1].match(/0x[a-f0-9]+[uUlL]*|\d+[uUlL]*|<<|>>|[()+\-*\/%&|^~]/gi) ?? [];
      if (parts.join("") === index[1].replace(/\s/g, "")) address += constant(index[1]) * size;
    }
    const fake: Allocation = { file, symbol: "typed absolute pointer", address, size };
    checkAllocations(p, [fake], { abi: 1, engineFiles: {}, contextSymbol: "unused" }, context);
  }
}
