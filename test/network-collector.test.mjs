import test from 'node:test';import assert from 'node:assert/strict';
import {collectNetwork,mergeNetwork} from '../src/network-collector.mjs';
const interfaces={eth0:[{family:'IPv4',internal:false,address:'10.2.0.1',cidr:'10.2.0.1/24'}],tailscale0:[{family:'IPv4',internal:false,address:'100.64.2.1',cidr:'100.64.2.1/32'}],docker0:[{family:'IPv4',internal:false,address:'172.17.0.1'}]};
test('collects actual route/interface evidence without inventing throughput',()=>{
 const n=collectNetwork({interfaces,os:'linux',readSpeed:()=>25000,peers:[{id:'m5',address:'100.88.157.24'}],command:()=>JSON.stringify([{dev:'tailscale0'}])});
 assert.equal(n.interfaces.length,2);assert.equal(n.interfaces[1].speed_mbps,null);assert.equal(n.links[0].route,'tailscale');assert.equal(n.links[0].remote_interface,null);assert.equal(n.links[0].measurement,undefined);
});
test('route refresh preserves independent measured transfers',()=>{
 const measurement={kind:'http-memory',bytes:1024,seconds:1,measured_at:'2026-11-22T00:00:00Z'};
 const n=mergeNetwork({links:[{peer_id:'m5',measurement}]},{interfaces:[],links:[{peer_id:'m5',route:'tailscale'}]});assert.deepEqual(n.links[0].measurement,measurement);
});
test('peer names cannot inject commands or resolve arbitrary hostnames',()=>{
 for(const peer of [{id:'x',address:'$(bad)'},{id:'x;bad',address:'1.2.3.4'}])assert.throws(()=>collectNetwork({interfaces,os:'linux',peers:[peer]}));
});
test('network prefixes are canonical rather than host CIDRs',()=>{
 const n=collectNetwork({interfaces,os:'linux',readSpeed:()=>null});assert.deepEqual(n.interfaces[0].networks,['10.2.0.0/24']);
});
