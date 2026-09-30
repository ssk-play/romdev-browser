// These public APIs exist in romdev-core-host's JS; its current declaration file omits them.
import "romdev-core-host";
declare module "romdev-core-host" {
  interface LibretroHost {
    serializeState(): Uint8Array;
    unserializeState(state: Uint8Array): number;
  }
}
