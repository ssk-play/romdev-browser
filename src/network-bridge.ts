// Optional NES cartridge mailbox, separate from touch ($03F8) and engine health ($03FE).
// Only advertised "NX", ABI 1 cartridges receive status or emit browser actions.
import type { Platform } from "./protocol.ts";
type Memory = { readMemory(region: string, offset: number, length: number): ArrayLike<number>; writeMemory(region: string, offset: number, bytes: Uint8Array): void };
export type NetworkAction = "join" | "invite" | "leave";
export const NETWORK_MAILBOX = 0x03e0;
export class NetworkBridge {
  status = 1; // idle; 2 connecting, 3 waiting, 4 playing, 5 ended
  private announced = false;
  reset() { this.status = 1; this.announced = false; }
  private present(host: Memory, platform: Platform) {
    if (platform !== "nes") return false;
    const b = host.readMemory("system_ram", NETWORK_MAILBOX, 3);
    return b[0] === 0x4e && b[1] === 0x58 && b[2] === 1;
  }
  write(host: Memory, platform: Platform, playing = false) {
    if (this.present(host, platform)) host.writeMemory("system_ram", NETWORK_MAILBOX + 4, Uint8Array.of(playing ? 4 : this.status));
  }
  poll(host: Memory, platform: Platform, playing = false): NetworkAction | null {
    if (!this.present(host, platform)) return null;
    // In a match only leave is allowed. Never consume/ack RAM while rollback is active: peers must hash identical RAM.
    const command = host.readMemory("system_ram", NETWORK_MAILBOX + 3, 1)[0];
    const action: NetworkAction | undefined = ({ 1: "join", 2: "invite", 3: "leave" } as const)[command as 1 | 2 | 3];
    if (playing) {
      if (action !== "leave" || this.announced) return null;
      this.announced = true;
      return action;
    }
    if (!action) return null;
    host.writeMemory("system_ram", NETWORK_MAILBOX + 3, Uint8Array.of(0));
    return action;
  }
}
