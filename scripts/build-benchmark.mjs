// Browser diagnostics use the exact cartridge fixtures that pass the real-core tests.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture } from '../tests/bundle-helpers.mjs';
const out=new URL('../dist/benchmark/',import.meta.url);
await mkdir(out,{recursive:true});
const roms={};
for(const platform of ['gb','gbc','nes']){
 const bytes=await fixture(platform),file=`fixture.${platform}`;
 await writeFile(new URL(file,out),bytes);
 roms[platform]={file,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const manifest=JSON.parse(await readFile(new URL('../dist/manifest.json',import.meta.url),'utf8'));
await writeFile(new URL('fixtures.json',out),JSON.stringify({roms,build:manifest.bundleBuild,version:manifest.version,wasmSource:manifest.wasmSource},null,2)+'\n');
await writeFile(new URL('index.html',out),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Multiplayer benchmark</title><style>body{margin:0;background:#101724;color:#dce8ff;font:15px system-ui;padding:16px;max-width:440px}canvas{width:100%;image-rendering:pixelated;background:#050a10}pre{white-space:pre-wrap;font:12px ui-monospace}button{font:inherit;padding:12px;margin:8px 0}p{line-height:1.5}</style><h1>Multiplayer benchmark</h1><p id="status">Preparing deterministic cores…</p><canvas></canvas><button id="pad" type="button">Hold to move player 1</button><p>Other seats use repeatable bot inputs. This measures local emulation and browser scheduling; it does not measure a live network match.</p><pre id="results"></pre><script type="module" src="../benchmark.js"></script></html>`);
