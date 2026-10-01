import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import {Toolchain}from'../src/toolchain.ts';import {Cc65Toolchain}from'../src/cc65.ts';import {nodeLoader,runtimeFor}from'./helpers.mjs';
import {checkAllocations,checkAssemblyAliases,contextAddress,checkPointerAliases,checkLiteralWrites}from'../src/memory-contract.ts';
const loader=nodeLoader(),sdcc=new Toolchain(loader),cc65=new Cc65Toolchain(loader);
const engine='unsigned char mp_context[32];',contract={abi:1,contextSymbol:'mp_context',engineFiles:{'engine.c':createHash('sha256').update(engine).digest('hex')}};
const input=(platform,main,extra={})=>({platform,memoryContract:contract,sources:{'engine.c':engine,'main.c':main,...extra}});
for(const platform of ['gb','gbc'])test(`${platform}: actual compiler records reject macros, arrays, context overlap and permit the last game byte`,async()=>{
 for(const declarations of ['#define HERE 0xd0f0\nunsigned char __at(HERE) alias;', 'unsigned int __at(0xd0ef) crossing;','unsigned char __at(0xd0ee) array[3];','unsigned char __at(0xc203) context_alias;']){
  const r=await sdcc.build(input(platform,declarations+'\nvoid main(void){}'),runtimeFor(platform));assert.equal(r.ok,false,r.log);assert.match(r.issues[0].message,/reserved|absolute/);
 }
 const good=await sdcc.build(input(platform,'unsigned char __at(0xd0ef) last;\nvoid main(void){last=1;}'),runtimeFor(platform));assert.equal(good.ok,true,good.log+JSON.stringify(good.issues));
 for(const main of ['void main(void){*(unsigned int*)0xd0ef=42;}','void main(void){*(unsigned char*)0xc203=1;}']){const r=await sdcc.build(input(platform,main),runtimeFor(platform));assert.equal(r.ok,false,r.log);assert.match(r.issues[0].message,/reserved/);}
 const badIdentity=input(platform,'void main(void){}');badIdentity.sources['engine.c']+=' ';const bad=await sdcc.build(badIdentity,runtimeFor(platform));assert.equal(bad.ok,false);assert.match(bad.issues[0].message,/identity/);
});
test('mirror aliases and unknown assembly extents cannot evade engine ownership',()=>{
 const c={...contract,engineFiles:contract.engineFiles};
 for(const [p,address,size]of [['gb',0xf0ef,2],['nes',0xbef,2],['nes',0x13f0,1]])assert.throws(()=>checkAllocations(p,[{file:'main.c',symbol:'alias',address,size}],c),/reserved/);
 for(const asm of ['alias = $03F0','alias = BASE + 2','.org $03EF','.org BASE','alias .equ $03F0'])assert.throws(()=>checkAssemblyAliases('main.s',asm,'nes',[]),/absolute/);
 assert.equal(contextAddress('_mp_context 006100 RLA',c,'nes'),0x6100);
 assert.equal(contextAddress(' 0000C203 _mp_context module',c,'gb'),0xc203);
 for(const cpp of ['*(unsigned int*)0x03ef=1;','*((unsigned char*)0x0300+240)=1;','((unsigned char*)0x0300)[240U]=1;','*(unsigned char*)01760=1;','*(struct Unknown*)0x03f0=1;'])assert.throws(()=>checkPointerAliases('main.c',cpp,'nes'),/reserved|unverifiable|unsupported/);
 checkPointerAliases('main.c','const char *s="(unsigned int*)0x03ef"; *(unsigned char*)(0x0300+239)=1;','nes');
 checkLiteralWrites('main.c',' sta (ptr1),y\n sta _ordinary,x\n','nes');
 assert.throws(()=>checkLiteralWrites('main.c',' sta ($03ef + 1)\n','nes'),/reserved/);
});
// Runtime source text imports are intercepted in the Node suite, as in server tests.
import {registerHooks}from'node:module';import {readFileSync}from'node:fs';
registerHooks({load(url,c,next){if(/\.(c|h|s|cfg)$/.test(url))return{format:'module',source:`export default ${JSON.stringify(readFileSync(new URL(url),'utf8'))}`,shortCircuit:true};return next(url,c);}});
const {NES_RUNTIME}=await import('../src/runtime.ts');
test('NES folded 16-bit writes crossing the header fail; ordinary boundary and old solo builds remain valid',async()=>{
 const bad=await cc65.build(input('nes','void main(void){*(unsigned int*)0x03ef=42;}'),NES_RUNTIME);assert.equal(bad.ok,false);assert.match(bad.issues[0].message,/reserved/);
 const good=await cc65.build(input('nes','void main(void){*(unsigned char*)0x03ef=42;}'),NES_RUNTIME);assert.equal(good.ok,true,good.log+JSON.stringify(good.issues));
 const indirect=await cc65.build(input('nes','void fill(unsigned char *p,unsigned char n){while(n--)p[n]=42;}\nvoid main(void){fill((unsigned char*)0x0400,16);}'),NES_RUNTIME);assert.equal(indirect.ok,true,indirect.log+JSON.stringify(indirect.issues));
 const alias=await cc65.build(input('nes','void main(void){}',{'aliases.s':'.segment "CODE"\n.org $03ef\nfoo: .res 2\n'}),NES_RUNTIME);assert.equal(alias.ok,false);assert.match(alias.issues[0].message,/absolute/);
 const include=await cc65.build(input('nes','void main(void){}',{'helper.s':'.segment "CODE"\n.include "bad.inc"\n','bad.inc':'sta $03f0\n'}),NES_RUNTIME);assert.equal(include.ok,false);assert.match(include.issues[0].message,/reserved/);
});
