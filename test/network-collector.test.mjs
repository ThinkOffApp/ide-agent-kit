import test from 'node:test';import assert from 'node:assert/strict';
import {collectNetwork,mergeNetwork} from '../src/network-collector.mjs';
const interfaces={eth0:[{family:'IPv4',internal:false,address:'10.2.0.1',cidr:'10.2.0.1/24'}],tailscale0:[{family:'IPv4',internal:false,address:'100.64.2.1',cidr:'100.64.2.1/32'}],docker0:[{family:'IPv4',internal:false,address:'172.17.0.1'}]};
test('collects actual route/interface evidence without inventing throughput',()=>{
 const n=collectNetwork({interfaces,os:'linux',readSpeed:()=>25000,peers:[{id:'m5',address:'100.88.157.24'}],command:()=>JSON.stringify([{dev:'tailscale0'}])});
 assert.equal(n.interfaces.length,2);assert.equal(n.interfaces[1].speed_mbps,null);assert.equal(n.links[0].route,'tailscale');assert.equal(n.links[0].remote_interface,null);assert.equal(n.links[0].measurement,undefined);
});
test('route refresh preserves independent measured transfers',()=>{
 const measurement={kind:'http-memory',bytes:1024,seconds:1,measured_at:'2026-11-22T00:00:00Z'};
 const n=mergeNetwork({links:[{peer_id:'m5',route:'tailscale',local_interface:'tailscale0',measurement}]},{interfaces:[],links:[{peer_id:'m5',route:'tailscale',local_interface:'tailscale0'}]});assert.deepEqual(n.links[0].measurement,measurement);
});
test('peer names cannot inject commands or resolve arbitrary hostnames',()=>{
 for(const peer of [{id:'x',address:'$(bad)'},{id:'x;bad',address:'1.2.3.4'}])assert.throws(()=>collectNetwork({interfaces,os:'linux',peers:[peer]}));
});
test('network prefixes are canonical rather than host CIDRs',()=>{
 const n=collectNetwork({interfaces,os:'linux',readSpeed:()=>null});assert.deepEqual(n.interfaces[0].networks,['10.2.0.0/24']);
});
test('route changes invalidate old throughput and removed peers disappear',()=>{
 const n=mergeNetwork({links:[{peer_id:'m5',route:'lan',local_interface:'eth0',measurement:{kind:'http-memory'}},{peer_id:'gone'}]},{interfaces:[],links:[{peer_id:'m5',route:'tailscale',local_interface:'tailscale0'}]});assert.equal(n.links.length,1);assert.equal(n.links[0].measurement,undefined);assert.equal(n.links[0].measurement_stale,true);
});
test('special interfaces are not labelled Ethernet and authorized host addresses are retained',()=>{
 const i={ib0:interfaces.eth0,thunderbolt0:interfaces.eth0,tailscale0:interfaces.tailscale0};const n=collectNetwork({interfaces:i,os:'linux',readSpeed:()=>null});assert.equal(n.interfaces[0].kind,'unknown');assert.equal(n.interfaces[1].kind,'thunderbolt');assert.deepEqual(n.interfaces[0].addresses,['10.2.0.1']);assert.deepEqual(n.interfaces[2].networks,[]);
});
test('publisher patches only network on an existing slot and rejects absent slots',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {publishNetwork}=await import('../src/network-collector.mjs');
 const dir=await mkdtemp(join(tmpdir(),'iak-net-'));t.after(()=>rm(dir,{recursive:true,force:true}));const keyFile=join(dir,'key');await writeFile(keyFile,'private-test-key');
 const c={baseUrl:'https://groupmind.one/api/v1',userId:'petrus',deviceId:'asus1',keyFile};let patched;
 await publishNetwork(c,{interfaces:[],links:[]},{fetchImpl:async(u,o)=>{if(o.method==='PATCH'){patched=JSON.parse(o.body);return {ok:true};}return {ok:true,json:async()=>({devices:{asus1:{name:'keep',network:{note:'preserved'}}}})};}});
 assert.deepEqual(Object.keys(patched),['network']);assert.equal(patched.network.note,'preserved');
 await assert.rejects(publishNetwork(c,{interfaces:[],links:[]},{fetchImpl:async()=>({ok:true,json:async()=>({devices:{}})})}),/Existing device slot required/);
});
test('publisher allows explicit local API targets and rejects arbitrary destinations',async()=>{
 const {publishNetwork}=await import('../src/network-collector.mjs');
 for(const baseUrl of ['https://evil.example/api/v1','http://100.128.1.2/api/v1','http://user:pass@127.0.0.1/api/v1','http://127.0.0.1/api/v1?token=x'])await assert.rejects(publishNetwork({baseUrl},{interfaces:[],links:[]}),/Unsupported publish destination/);
 await assert.rejects(publishNetwork({baseUrl:'http://100.111.140.100:3005/api/v1'},{interfaces:[],links:[]}),/Invalid intent identifier/);
});
