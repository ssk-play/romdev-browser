// One build entry for every platform: SDCC (sm83) for gb/gbc, cc65 for nes. Used by the compiler worker and the server.
import { Toolchain, type BuildInput, type BuildResult } from "./toolchain.ts";
import { Cc65Toolchain } from "./cc65.ts";
import { NES_RUNTIME, RUNTIME } from "./runtime.ts";
import type { ToolchainName } from "./platforms.ts";
import type { ShareName, ToolLoader } from "./wasmtool.ts";

/** The tools and share tree each toolchain downloads (as dist/wasm/<tool>.wasm + <share>-share.json). */
export const TOOLCHAIN_FILES: Record<ToolchainName, { tools: string[]; share: ShareName }> = {
  sdcc: { tools: ["mcpp", "sdcc", "sdasgb", "sdld"], share: "sdcc" },
  cc65: { tools: ["cc65", "ca65", "ld65"], share: "cc65" },
};

export function builder(loader: ToolLoader, cacheTag = ""): (input: BuildInput) => Promise<BuildResult> {
  const sdcc = new Toolchain(loader, cacheTag);
  const cc65 = new Cc65Toolchain(loader);
  return (input) => (input.platform === "nes" ? cc65.build(input, NES_RUNTIME) : sdcc.build(input, RUNTIME[input.platform]));
}
