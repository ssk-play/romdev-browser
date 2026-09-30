import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBridge, NETWORK_MAILBOX as at } from '../src/network-bridge.ts';
const fixture = (advertised = true) => {
  const ram = new Uint8Array(2048);
  if (advertised) ram.set([0x4e,0x58,1,0,0], at);
  const host = { readMemory: (r,o,n) => ram.slice(o,o+n), writeMemory: (r,o,b) => ram.set(b,o) };
  return { ram, host, bridge: new NetworkBridge() };
};
test('only opted-in NES cartridges receive network status and commands are consumed once in the local lobby', () => {
  const { ram, host, bridge } = fixture();
  bridge.write(host,'nes'); assert.equal(ram[at+4],1);
  ram[at+3]=2; assert.equal(bridge.poll(host,'nes'),'invite'); assert.equal(bridge.poll(host,'nes'),null);
  bridge.status=3; bridge.write(host,'nes'); assert.equal(ram[at+4],3);
  const plain=fixture(false); bridge.write(plain.host,'nes'); assert.deepEqual(plain.ram,new Uint8Array(2048));
  ram[at+4]=0; bridge.write(host,'gbc'); assert.equal(ram[at+4],0);
});
test('match status is identical despite local lobby status; leave never mutates hashed RAM or emits twice', () => {
  const { ram, host, bridge } = fixture(); bridge.status=3;
  bridge.write(host,'nes',true); assert.equal(ram[at+4],4);
  ram[at+3]=1; assert.equal(bridge.poll(host,'nes',true),null); assert.equal(ram[at+3],1);
  ram[at+3]=3; const before=ram.slice();
  assert.equal(bridge.poll(host,'nes',true),'leave'); assert.deepEqual(ram,before);
  assert.equal(bridge.poll(host,'nes',true),null); bridge.reset(); assert.equal(bridge.poll(host,'nes',true),'leave');
});
