import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkPlan, distribution } from '../src/benchmark-metrics.ts';
test('the full performance gate uses the current window and enough samples for p99', () => {
 assert.deepEqual(benchmarkPlan(new URLSearchParams()), { smoke:false, depth:60, warmupBursts:2, measuredBursts:200 });
 assert.equal(benchmarkPlan(new URLSearchParams('window=24')).depth,24);
 assert.deepEqual(benchmarkPlan(new URLSearchParams('profile=smoke')), { smoke:true, depth:60, warmupBursts:0, measuredBursts:2 });
 for(const value of ['0','61','NaN']) assert.equal(benchmarkPlan(new URLSearchParams({window:value})).depth,60);
});
test('benchmark percentiles preserve measured tails and distinguish missing from zero samples',()=>{
 assert.equal(distribution([]),null);
 assert.deepEqual(distribution([0]),{count:1,p50:0,p95:0,p99:0,max:0});
 const samples=Array.from({length:100},(_,i)=>100-i);
 assert.deepEqual(distribution(samples),{count:100,p50:50,p95:95,p99:99,max:100});
 assert.equal(samples[0],100);
 for(const v of [-1,Infinity,NaN])assert.throws(()=>distribution([v]),/sample/);
});
