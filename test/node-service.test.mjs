import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNode, createNode, runAdapter, systemdUnit } from '../src/node-service.mjs';
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'iak-node-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c={id:'m5',handle:'@deep',host:'100.88.157.24',rooms:['thinkoff-development'],keyFile:join(dir,'key'),tokenFile:join(dir,'token'),stateFile:join(dir,'state'),deliver:['/bin/true'],freshSession:['/bin/true']};
 await writeFile(c.keyFile,'secret');return c;
}
test('reject public binds, shell command strings and invalid identifiers',async t=>{
 const c=await fixture(t);assert.equal(validateNode(c),c);
 for(const patch of [{host:'0.0.0.0'},{host:'100.128.1.2'},{host:'100.64.999.2'},{deliver:'echo hi'},{id:'x\nExecStart=bad'}])assert.throws(()=>validateNode({...c,...patch}));
});
test('baseline, exact mentions, pending retention and fresh-context replay',async t=>{
 const c=await fixture(t);let messages=[{id:'old',from:'petrus',body:'@deep old'}],calls=[],fail=true;
 const node=createNode(c,{fetchImpl:async()=>({ok:true,json:async()=>({messages})}),save:async()=>{},adapter:async(argv,p)=>{calls.push(p);if(p.type==='fresh_session')return {status:'fresh'};return {status:fail?'context_full':'delivered'};}});
 await node.init();assert.equal(await node.tick(),true);assert.equal(calls.length,0);
 messages=[{id:'new',from:'petrus',body:'@deep do task'},{id:'other',from:'petrus',body:'@deeply not yours'},...messages];
 assert.equal(await node.tick(),false);assert.equal(node.health().pending,1);assert.equal(calls.length,3);
 fail=false;assert.equal(await node.tick(),true);assert.equal(node.health().pending,0);assert.equal(calls.at(-1).deliveryId,'new');
 const count=calls.length;await node.tick();assert.equal(calls.length,count);
});
test('state survives restart and retries unconfirmed delivery',async t=>{
 const c=await fixture(t);let messages=[];
 const fetchImpl=async()=>({ok:true,json:async()=>({messages})});
 let node=createNode(c,{fetchImpl,adapter:async()=>{throw Error('private secret error');}});await node.init();await node.tick();
 messages=[{id:'queued',from:'petrus',body:'@deep retry'}];assert.equal(await node.tick(),false);
 assert.equal(node.health().error,'poll_or_delivery_failed');
 let deliveries=0;node=createNode(c,{fetchImpl,adapter:async()=>{deliveries++;return {status:'delivered'};}});await node.init();await node.tick();assert.equal(deliveries,1);
});
test('adapter receives untrusted text via stdin, not executable arguments',async t=>{
 const c=await fixture(t);const script=join(c.stateFile+'-adapter.mjs');
 await writeFile(script,"let s='';for await(const c of process.stdin)s+=c;const p=JSON.parse(s);console.log(JSON.stringify({status:'delivered',body:p.body}));");
 const body='$(touch /tmp/never) `uname` ; "\\n';const receipt=await runAdapter([process.execPath,script],{body});assert.equal(receipt.body,body);
});
test('service escapes systemd percent paths and rejects newline injection',()=>{
 assert.match(systemdUnit('/tmp/a%b','/usr/bin/node','/tmp/cli.mjs'),/a%%b/);
 assert.throws(()=>systemdUnit('/tmp/a\nb','/usr/bin/node','/tmp/cli'));
});
test('authenticated wake does not execute request bodies and rate limits',async t=>{
 const {wakeServer}=await import('../src/node-service.mjs');let calls=0;
 const server=wakeServer({tick:async()=>{calls++;},health:()=>({status:'ready'})},'test-token');
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/wake',{method:'POST'})).status,401);
 const headers={Authorization:'Bearer test-token'};
 assert.equal((await fetch(base+'/health',{headers})).status,200);
 assert.equal((await fetch(base+'/wake',{method:'POST',headers,body:'$(do not execute)'})).status,202);
 assert.equal((await fetch(base+'/wake',{method:'POST',headers})).status,429);assert.equal(calls,1);
});
test('room health announces only transitions and verifies sender',async t=>{
 const c=await fixture(t);c.healthRoom=c.rooms[0];let posts=0;
 const node=createNode(c,{save:async()=>{},fetchImpl:async(url,opt)=>{
  if(opt.method==='POST'){posts++;return {ok:true,json:async()=>({from:'@deep'})};}
  return {ok:true,json:async()=>({messages:[]})};
 }});await node.init();await node.tick();await node.announce();await node.announce();assert.equal(posts,1);
});
