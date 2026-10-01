import { readFileSync } from 'node:fs';
import { LibretroHost } from 'romdev-core-host';
import { ConsoleBundle } from '../src/bundle.ts';
import { runTool } from '../src/wasmtool.ts';
import { nodeLoader } from './helpers.mjs';
import { gbMultiplayer } from './fixtures/multiplayer/gb.mjs';
let nes;
export async function fixture(platform) {
 if(platform!=='nes')return gbMultiplayer(platform==='gbc');
 if(!nes)nes=(async()=>{
  const loader=nodeLoader(),files={'/work/pads.s':readFileSync(new URL('./fixtures/multiplayer/nes.s',import.meta.url),'utf8')};
  const a=await runTool(loader,'ca65',['-t','nes','-o','/work/pads.o','/work/pads.s'],{files,binaries:['/work/pads.o']});if(a.code)throw Error(a.log);
  const l=await runTool(loader,'ld65',['-C','/work/pads.cfg','-o','/work/pads.nes','/work/pads.o'],{files:{'/work/pads.o':a.binaries['/work/pads.o'],'/work/pads.cfg':readFileSync(new URL('./fixtures/multiplayer/nes.cfg',import.meta.url),'utf8')},binaries:['/work/pads.nes']});if(l.code)throw Error(l.log);return l.binaries['/work/pads.nes'];
 })();return nes;
}
export const config=(platform,mode='shared',slots=[0,1,2,3])=>({platform,mode,slots,capacity:4,epoch:7,seed:12,policy:'replace',window:24,rtcEpochSeconds:0});
export const frame=(c,f,masks=[0,0,0,0])=>({frame:f,masks:masks.map((m,i)=>c.slots.includes(i)?m:0),states:[0,1,2,3].map(i=>c.slots.includes(i)?1:0)});
export async function bundle(c,build='test-m1-7b412f74') {
 const core=c.platform==='nes'?'fceumm':'gambatte',loader=nodeLoader(),factory=await loader.factory(core),wasmBinary=new Uint8Array(readFileSync(new URL(`../dist/wasm/${core}.wasm`,import.meta.url)));
 return ConsoleBundle.boot(c,await fixture(c.platform),build,async()=>{const h=new LibretroHost();await h.loadCore({factory,wasmBinary,io:false});return h;});
}
