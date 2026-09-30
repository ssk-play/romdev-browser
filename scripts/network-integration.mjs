// Integration harness in the separate emulator project. No GPL code is imported by the app.
// Run from the app worktree with a dev-only MCP_BEARER in the environment:
// node ../romdev-browser/scripts/network-integration.mjs ./src/runtime/rollback.ts https://dev.chiptoy.com <game UUID> pair 100 80 30
// Replace "pair" with a waiting invitation room UUID, or "public" for a browser in Online play. Added delays affect only the second peer.
// A shared NES fixture is required; no persistent data is written and all joined rooms are cleaned up.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { LibretroHost } from 'romdev-core-host';
import { NetworkBridge } from '../src/network-bridge.ts';
import { RollbackCore } from '../src/rollback.ts';
import { writeTouches } from '../src/platforms.ts';
const browser=resolve(import.meta.dirname,'..');
const [clientModule, origin='https://dev.chiptoy.com', game, room='pair', out='60', incoming='40', duration='30']=process.argv.slice(2);
assert.ok(clientModule, 'Pass the client rollback.ts module path');
assert.ok(['dev.chiptoy.com','127.0.0.1','localhost'].includes(new URL(origin).hostname), 'Dev/local only');
assert.match(game??'',/^[0-9a-f-]{36}$/, 'Pass a disposable shared NES game UUID');
const { RollbackTimeline }=await import(pathToFileURL(resolve(clientModule)));
const outDelay=Number(out),inDelay=Number(incoming),seconds=Number(duration);
assert.ok([outDelay,inDelay,seconds].every(n=>Number.isFinite(n)&&n>=0)&&seconds>=5&&seconds<=300);
const remote=new URL(origin).hostname==='dev.chiptoy.com';
assert.ok(!remote||process.env.MCP_BEARER,'Dev requires its authorized MCP_BEARER; never prints credentials');
async function call(name,args={}){
 const r=await fetch(origin+(remote?'/mcp':'/mcp-dev'),{method:'POST',headers:{...(remote?{authorization:'Bearer '+process.env.MCP_BEARER}:{}),'content-type':'application/json','user-agent':'chiptoy-dev-test/1.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{game,...args}}})});
 const j=await r.json(),txt=j.result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('');if(j.result?.isError||!j.result)throw Error(txt??'MCP failed');return JSON.parse(txt);
}
const factory=(await import(pathToFileURL(browser+'/dist/wasm/fceumm.mjs'))).default;
const wasm=readFileSync(browser+'/dist/wasm/fceumm.wasm');
const romResponse=await fetch(origin+'/api/play/'+game+'/rom');assert.equal(romResponse.status,200);const rom=new Uint8Array(await romResponse.arrayBuffer());
const joins=[],sockets=[],peers=[],results=[];let failed=null;
async function peer(join, delay){
 const host=new LibretroHost();await host.loadCore({factory,wasmBinary:wasm,io:false});await host.loadMedia({platform:'nes',bytes:rom,name:'duel.nes'});
 host.writeMemory('save_ram',0,new Uint8Array(8192));host.reset();host.stepFrames(1);host.state.audioRing.length=0;
 const names=['right','left','up','down','a','b','select','start'];
 const bridge = new NetworkBridge();
 const core={save:()=>host.serializeState(),restore:s=>host.unserializeState(s),frame:m=>{host.setInput({ports:m.map(mask=>Object.fromEntries(names.map((b,i)=>[b,!!(mask&(1<<i))])))});bridge.write(host,'nes',true);writeTouches(host,'nes',[]);host.stepFrames(1)},hash:()=>{let h=2166136261;for(const r of ['system_ram','save_ram'])for(const b of host.readMemory(r,0,host.regionSize(r)))h=Math.imul(h^b,16777619);return h>>>0},discardAudio:()=>{host.state.audioRing.length=0}};
 const rollback=new RollbackCore(core),timeline=new RollbackTimeline(join.slot,{step:async(...a)=>{const c=rollback.step(...a);core.discardAudio();return c},replay:async(...a)=>rollback.replay(...a)});
 const ws=new WebSocket(origin.replace(/^http/,'ws')+'/api/network/'+game+'/socket?ticket='+join.ticket,{headers:{origin}});sockets.push(ws);
 let stopped=false,started=false,nextDue=0,busy=false,stalls=0,starving=false,maxPrediction=0,checks=0,frameWork=0,began=0,timer,finish; const sentAt=new Map(), rtts=[], ages=[];
 const done=new Promise(resolve=>finish=resolve);
 const send=m=>{if(ws.readyState===WebSocket.OPEN&&!stopped)ws.send(JSON.stringify(m))};
 const stop=reason=>{if(stopped)return;stopped=true;clearTimeout(timer);const r={slot:join.slot,frames:timeline.next,fps:Math.round(timeline.next*1000/(performance.now()-began)),rollbacks:timeline.rollbacks,replayed:timeline.replayed,maxPrediction,stalls,checks,medianRtt:rtts.sort((a,b)=>a-b)[Math.floor(rtts.length/2)],medianConfirmationMs:ages.sort((a,b)=>a-b)[Math.floor(ages.length/2)],health:[...host.readMemory('system_ram',0x3fe,2)],positions:[...host.readMemory('system_ram',0x300,7)],frameWorkMs:Math.round(frameWork),reason};results.push(r);console.log(JSON.stringify(r));finish(r)};
 async function tick(){
  if(stopped||busy)return;busy=true;const start=performance.now();
  try{
   await timeline.reconcile();for(const c of timeline.checks()){send({type:'check',...c});checks++}
   let n=0;while(!stopped&&performance.now()>=nextDue&&n++<3){
    if(!timeline.canAdvance){if(!starving)stalls++;starving=true;nextDue=performance.now();break}
    starving=false;const seq=timeline.next,k=seq%240;
    // Gold moves in both directions and jumps/dashes frequently, forcing browser corrections.
    const mask=(k<100?2:k<200?1:0)|(seq%97<3?16:0)|(seq%71<3?32:0);
    await timeline.advance(mask,(seq,mask)=>{sentAt.set(seq,performance.now());const msg={type:'input',seq,mask};if(delay)setTimeout(()=>send(msg),outDelay);else send(msg)});
    maxPrediction=Math.max(maxPrediction,timeline.prediction);await timeline.reconcile();
    for(const c of timeline.checks()){send({type:'check',...c});checks++}
    nextDue=Math.max(nextDue+1000/host.status.coreFps,performance.now()-2*1000/host.status.coreFps);
   }
  }catch(e){failed=String(e);stop(failed)}
  finally{frameWork+=performance.now()-start;busy=false;if(!stopped)timer=setTimeout(tick,Math.max(1,Math.ceil(nextDue-performance.now())))}
 }
 ws.on('message',raw=>{
  const m=JSON.parse(raw.toString());
  if(m.type==='welcome'){assert.equal(m.protocol,'rollback-v1');send({type:'ping',sent:performance.now()});send({type:'ready',protocol:'rollback-v1'})}
  else if(m.type==='pong')rtts.push(Math.round(performance.now()-m.sent));
  else if(m.type==='start'){started=true;began=nextDue=performance.now();tick();setTimeout(()=>stop('test complete'),seconds*1000)}
  else if(m.type==='input'){
   const receive=()=>{if(stopped)return;try{ages.push(Math.round(performance.now()-sentAt.get(m.seq)));sentAt.delete(m.seq);timeline.receive(m.seq,m.masks)}catch(e){failed=String(e);stop(failed)}};
   if(delay&&inDelay)setTimeout(receive,inDelay);else receive();
  }else if(m.type==='ended'){failed=m.reason;stop(m.reason)}
 });
 ws.on('error',()=>{failed='socket error';stop(failed)});ws.on('close',()=>{if(!stopped){failed='socket closed';stop(failed)}});
 const p={timeline,done,stop};peers.push(p);console.log('peer ready, slot '+join.slot);
 setTimeout(()=>{if(!started){failed='start timeout';stop(failed)}},30_000).unref();return p;
}
try{
 const first=await call('join_game',{mode:room==='public'?'public':'invite',client:crypto.randomUUID(),...(room&&room!=='pair'&&room!=='public'?{room}:{})});joins.push(first);
 if(room==='pair'){
  const second=await call('join_game',{mode:'invite',room:first.room,client:crypto.randomUUID()});joins.push(second);
  await Promise.all([peer(first,false),peer(second,true)]);
 }else await peer(first,true);
 await Promise.all(peers.map(p=>p.done));

 // Live jitter can exhaust the bounded prediction window; report stalls rather than hiding them.
 // Zero starvation under fixed 100ms delay is covered by the client's virtual timing test.
 assert.equal(failed,null);assert.ok(results.every(r=>r.checks>=seconds-3&&r.fps>=58&&r.health.every(x=>x===0)),JSON.stringify(results));
}finally{
 for(const ws of sockets)ws.close();for(const j of joins)await call('leave_game',{room:j.room,client:j.client}).catch(()=>{});
}
