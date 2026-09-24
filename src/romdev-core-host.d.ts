declare module "romdev-core-host" {
  export class LibretroHost {
    constructor(opts?: Record<string, unknown>);
    state: { audioRing: Int16Array[] } & Record<string, unknown>;
    status: { audioSampleRate: number } & Record<string, unknown>;
    loadCore(opts: { factory: unknown; wasmBinary: Uint8Array; io?: false }): Promise<void>;
    loadMedia(args: { platform: string; bytes: Uint8Array; name?: string }): Promise<void>;
    unloadMedia(): void;
    stepFrames(n: number): void;
    screenshotRgba(): { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number };
    setInput(input: { ports: Record<string, boolean>[] }): void;
    saveState(name: string): unknown;
    loadState(name: string): unknown;
    regionSize(region: string): number;
    readMemory(region: string, offset: number, length: number): ArrayLike<number>;
    writeMemory(region: string, offset: number, bytes: Uint8Array): void;
    reset(): void;
  }
}
