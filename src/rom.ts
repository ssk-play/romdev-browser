export type Platform = "gb" | "gbc";

export const ROM_SIZE = 0x8000; // 32 KB, two banks, no MBC bank switching.

const NINTENDO_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

// MBC1/2/3/5 + BATTERY. The vendored gb_crt0.s declares $03 (MBC1+RAM+BATTERY).
const BATTERY_CART_TYPES = new Set([0x03, 0x06, 0x0f, 0x10, 0x13, 0x1b, 0x1e]);

/** Highest byte address an Intel HEX file writes, plus one. */
export function ihxHighWaterMark(ihx: string): number {
  let high = 0;
  let max = 0;
  for (const raw of ihx.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(":")) continue;
    const count = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x00) max = Math.max(max, ((high << 16) | addr) + count);
    else if (type === 0x04) high = parseInt(line.slice(9, 9 + count * 2), 16);
    else if (type === 0x01) break;
  }
  return max;
}

export function ihxToBin(ihx: string, size: number, fill = 0xff): Uint8Array {
  const out = new Uint8Array(size).fill(fill);
  let high = 0;
  for (const raw of ihx.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(":")) continue;
    const count = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = line.slice(9, 9 + count * 2);
    if (type === 0x00) {
      const base = (high << 16) | addr;
      for (let i = 0; i < count; i++) {
        if (base + i < size) out[base + i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      }
    } else if (type === 0x04) high = parseInt(data, 16);
    else if (type === 0x01) break;
  }
  return out;
}

/**
 * Fill the cartridge header the way romdev's build pipeline does with rgbfix
 * (-v -p 0xFF [-C] -m <type> -r <ram>): logo, title, CGB flag, cart type
 * pass-through for battery carts, header + global checksums.
 */
export function fixHeader(rom: Uint8Array, platform: Platform, title = ""): Uint8Array {
  rom.set(NINTENDO_LOGO, 0x104);
  const ascii = title.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 11);
  for (let i = 0; i < 11; i++) rom[0x134 + i] = i < ascii.length ? ascii.charCodeAt(i) : 0;
  rom[0x13f] = rom[0x140] = rom[0x141] = rom[0x142] = 0; // manufacturer code
  rom[0x143] = platform === "gbc" ? 0xc0 : 0x00;
  rom[0x144] = rom[0x145] = 0; // new licensee
  rom[0x146] = 0; // no SGB
  const declType = rom[0x147];
  const declRam = rom[0x149];
  const cart = BATTERY_CART_TYPES.has(declType) ? declType : 0x00;
  rom[0x147] = cart;
  rom[0x148] = 0x00; // 32 KB
  rom[0x149] = cart !== 0 && declRam >= 1 && declRam <= 5 ? declRam : 0x00;
  rom[0x14a] = 0x01; // non-Japanese
  rom[0x14b] = 0x33; // use new licensee code
  rom[0x14c] = 0x00; // version
  let hc = 0;
  for (let i = 0x134; i <= 0x14c; i++) hc = (hc - rom[i] - 1) & 0xff;
  rom[0x14d] = hc;
  let gc = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) gc = (gc + rom[i]) & 0xffff;
  rom[0x14e] = gc >> 8;
  rom[0x14f] = gc & 0xff;
  return rom;
}
