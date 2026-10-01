import type { Pixels } from "./multiplayer.ts";

export interface PixelRegion { x: number; y: number; width: number; height: number }
/** Diagnostic checksum of a small rendered region, never a causal-state or security hash. */
export function pixelProbe(p: Pixels, r: PixelRegion): string {
  if (![r.x,r.y,r.width,r.height].every(Number.isInteger) || r.x<0 || r.y<0 || r.width<1 || r.height<1 || r.width*r.height>4096 || r.x+r.width>p.width || r.y+r.height>p.height) throw new Error("invalid pixel probe");
  let hash=0x811c9dc5;
  for(let y=r.y;y<r.y+r.height;y++) for(let x=r.x;x<r.x+r.width;x++) for(let c=0;c<4;c++) hash=Math.imul(hash^p.rgba[(y*p.width+x)*4+c],0x01000193);
  return (hash>>>0).toString(16).padStart(8,"0");
}
