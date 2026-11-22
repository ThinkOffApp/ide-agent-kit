import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNode, createNode, runAdapter, systemdUnit } from '../src/node-service.mjs';
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'iak-node-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c={id:'m5',handle:'@deepm5',host:'100.88.157.24',rooms:['thinkoff-development'],keyFile:join(dir,'key'),tokenFile:join(dir,'token'),stateFile:join(dir,'state'),deliver:['/bin/true'],freshSession:['/bin/true']};
 await writeFile(c.keyFile,'secret');return c;
}
test('reject public binds, shell command strings and invalid identifiers',async t=>{
 const c=await fixture(t);assert.equal(validateNode(c),c);
 for(const patch of [{host:'0.0.0.0'},{host:'100.128.1.2'},{host:'100.64.999.2'},{deliver:'echo hi'},{id:'x\nExecStart=bad'}])assert.throws(()=>validateNode({...c,...patch}));
});
test('baseline, exact mentions, pending retention and fresh-context replay',async t=>{
 const c=await fixture(t);let clock=0;let messages=[{id:'old',from:'petrus',body:'@deepm5 old'}],calls=[],fail=true;
 const node=createNode(c,{now:()=>clock,fetchImpl:async()=>({ok:true,json:async()=>({messages})}),save:async()=>{},adapter:async(argv,p)=>{calls.push(p);if(p.type==='fresh_session')return {status:'fresh'};return {status:fail?'context_full':'delivered'};}});
 await node.init();assert.equal(await node.tick(),true);assert.equal(calls.length,0);
 messages=[{id:'new',from:'petrus',body:'@deepm5 do task'},{id:'other',from:'petrus',body:'@deepm5ly not yours'},...messages];
 assert.equal(await node.tick(),false);assert.equal(node.health().pending,1);assert.equal(calls.length,3);
 fail=false;clock=20000;assert.equal(await node.tick(),true);assert.equal(node.health().pending,0);assert.equal(calls.at(-1).deliveryId,'new');
 const count=calls.length;await node.tick();assert.equal(calls.length,count);
});
test('state survives restart and retries unconfirmed delivery',async t=>{
 const c=await fixture(t);let messages=[];
 const fetchImpl=async()=>({ok:true,json:async()=>({messages})});
 let node=createNode(c,{now:()=>0,fetchImpl,adapter:async()=>{throw Error('private secret error');}});await node.init();await node.tick();
 messages=[{id:'queued',from:'petrus',body:'@deepm5 retry'}];assert.equal(await node.tick(),false);
 assert.equal(node.health().error,'delivery_retry_pending');
 let deliveries=0;node=createNode(c,{now:()=>20000,fetchImpl,adapter:async()=>{deliveries++;return {status:'delivered'};}});await node.init();await node.tick();assert.equal(deliveries,1);
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
  if(opt.method==='POST'){posts++;return {ok:true,json:async()=>({from:'@deepm5'})};}
  return {ok:true,json:async()=>({messages:[]})};
 }});await node.init();await node.tick();await node.announce();await node.announce();assert.equal(posts,1);
});
test('shared handles require a node tag and reject other node mentions',async t=>{
 const c=await fixture(t);assert.throws(()=>validateNode({...c,handle:'@deep'}));c.handle='@deep';c.nodeTag='[node:m5]';let messages=[],ids=[];
 const n=createNode(c,{save:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({messages})}),adapter:async(a,p)=>{ids.push(p.deliveryId);return {status:'delivered'};}});await n.init();await n.tick();
 messages=[{id:'wrong',from:'petrus',body:'@deep [node:asus2] task'},{id:'right',from:'petrus',body:'@deep [node:m5] task'}];await n.tick();assert.deepEqual(ids,['right']);
});
test('poison messages back off and dead-letter while later work proceeds',async t=>{
 const c=await fixture(t);let clock=0,messages=[],ids=[],logs=[];
 const n=createNode(c,{now:()=>clock,save:async()=>{},log:x=>logs.push(x),fetchImpl:async()=>({ok:true,json:async()=>({messages})}),adapter:async(a,p)=>{if(p.deliveryId==='bad')throw Error('SECRET body');ids.push(p.deliveryId);return {status:'delivered'};}});
 await n.init();await n.tick();messages=[{id:'good',from:'petrus',body:'@deepm5 good'},{id:'bad',from:'petrus',body:'@deepm5 bad'}];await n.tick();assert.deepEqual(ids,['good']);
 clock=15000;await n.tick();clock=45000;await n.tick();assert.equal(n.health().deadLetters,1);assert.equal(n.health().pending,0);assert.doesNotMatch(JSON.stringify(logs),/SECRET/);
});
test('catch-up gap recovers after three failures with an explicit skipped window',async t=>{
 const c=await fixture(t);let messages=[];const n=createNode(c,{save:async()=>{},log:()=>{},fetchImpl:async()=>({ok:true,json:async()=>({messages})})});await n.init();await n.tick();
 messages=Array.from({length:100},(_,i)=>({id:String(i),from:'petrus',body:'unaddressed'}));await n.tick();await n.tick();await n.tick();assert.equal(n.health().skippedWindow.room,c.rooms[0]);assert.equal(n.health().error,null);assert.equal(n.health().attention,1);
});
test('ack archives attention without dropping pending work and returns ready',async t=>{
 const {readFile}=await import('node:fs/promises');const c=await fixture(t);
 await writeFile(c.stateFile,JSON.stringify({seen:[],pending:[],deadLetters:[{id:'bad',body:'private evidence'}],ready:true,skippedWindow:{room:c.rooms[0]}}));
 await writeFile(c.stateFile+'.ack',JSON.stringify({id:'test-ack'}));
 const n=createNode(c,{log:()=>{},fetchImpl:async()=>({ok:true,json:async()=>({messages:[]})})});await n.init();await n.tick();assert.equal(n.health().status,'ready');assert.equal(n.health().attention,0);
 const archive=JSON.parse(await readFile(c.stateFile+'.attention-test-ack.json'));assert.equal(archive.deadLetters[0].id,'bad');assert.equal(archive.skippedWindow.room,c.rooms[0]);
});
test('announcement never mutates state while a slow delivery owns it',async t=>{
 const c=await fixture(t);c.healthRoom=c.rooms[0];let messages=[],posts=0,release;
 const gate=new Promise(ok=>{release=ok;});
 const n=createNode(c,{save:async()=>{},fetchImpl:async(u,o)=>o.method==='POST'?(posts++,{ok:true,json:async()=>({from:c.handle})}):{ok:true,json:async()=>({messages})},adapter:async()=>{await gate;return {status:'delivered'};}});
 await n.init();await n.tick();messages=[{id:'slow',from:'petrus',body:'@deepm5 slow'}];const tick=n.tick();
 while(!n.health().busy)await new Promise(ok=>setImmediate(ok));await n.announce();assert.equal(posts,0);release();await tick;await n.announce();assert.equal(posts,1);
});
test('queued delivery retains attachment and reply context',async t=>{
 const c=await fixture(t);let messages=[],received;
 const n=createNode(c,{save:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({messages})}),adapter:async(a,p)=>{received=p.message;return {status:'delivered'};}});await n.init();await n.tick();
 messages=[{id:'attachment',from:'petrus',body:'@deepm5 inspect',image_url:'https://example.org/image.png',file_url:'https://example.org/report.pdf',reply_to:{id:'parent',body:'context'}}];await n.tick();assert.equal(received.image_url,messages[0].image_url);assert.deepEqual(received.reply_to,messages[0].reply_to);assert.equal(received.file_url,messages[0].file_url);
});
test('unaddressed room traffic cannot grow the durable seen list unbounded',async t=>{
 const c=await fixture(t);await writeFile(c.stateFile,JSON.stringify({seen:Array.from({length:6039},(_,i)=>String(i)),pending:[],deadLetters:[],ready:true}));
 const n=createNode(c,{fetchImpl:async()=>({ok:true,json:async()=>({messages:[]})})});await n.init();await n.tick();
 const {readFile}=await import('node:fs/promises');assert.equal(JSON.parse(await readFile(c.stateFile)).seen.length,5000);
});
