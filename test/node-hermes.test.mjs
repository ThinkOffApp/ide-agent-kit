import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hermesReceipt} from '../src/node-hermes.mjs';
test('Hermes resumes explicit sessions, rotates without deleting transcripts and deduplicates receipts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'iak-hermes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c={binary:'/bin/hermes',stateFile:join(dir,'state'),commitmentsFile:join(dir,'commitments')};await writeFile(c.commitmentsFile,'Keep pending QCD task');
 let calls=[],failure=false;const run=async(argv,input)=>{calls.push({argv,input});return JSON.stringify({type:'result',session_id:'session-1',exit_code:failure?1:0,error:failure?'Context length exceeded: max compression attempts (3) reached.':undefined});};
 const p={deliveryId:'one',message:{body:'@deep $(untrusted)'}};
 assert.equal((await hermesReceipt(c,'deliver',p,run)).status,'delivered');await hermesReceipt(c,'deliver',p,run);assert.equal(calls.length,1);
 failure=true;assert.equal((await hermesReceipt(c,'deliver',{...p,deliveryId:'two'},run)).status,'context_full');assert.ok(calls.at(-1).argv.includes('--resume'));
 await hermesReceipt(c,'fresh',{},run);const state=JSON.parse(await readFile(c.stateFile));assert.equal(state.session,null);assert.deepEqual(state.archives,['session-1']);
 failure=false;await hermesReceipt(c,'deliver',{...p,deliveryId:'two'},run);assert.ok(!calls.at(-1).argv.includes('--resume'));assert.match(calls.at(-1).input,/Keep pending QCD/);
});
test('missing receipt or unrelated terminal failure never counts as delivered',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'iak-hermes-'));t.after(()=>rm(dir,{recursive:true,force:true}));const c={binary:'/bin/hermes',stateFile:join(dir,'state'),commitmentsFile:join(dir,'notes')};await writeFile(c.commitmentsFile,'notes');
 for(const output of ['not json',JSON.stringify({type:'result',session_id:'s',exit_code:1,error:'provider unavailable'})])await assert.rejects(hermesReceipt(c,'deliver',{deliveryId:'x',message:{body:'task'}},async()=>output));
});
