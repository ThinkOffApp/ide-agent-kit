// SPDX-License-Identifier: AGPL-3.0-only
import { networkInterfaces, platform } from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
const run = (bin,args) => {try{return execFileSync(bin,args,{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']});}catch{return '';}};
const speed = name => {try{const n=Number(readFileSync(`/sys/class/net/${name}/speed`,'utf8'));return n>0?n:null;}catch{return null;}};
export function collectNetwork({peers=[], interfaces=networkInterfaces(), os=platform(), command=run, readSpeed=speed, measuredAt=new Date().toISOString()}={}) {
  const inventory=[];
  for (const [name, addresses] of Object.entries(interfaces)) {
    const ipv4=(addresses||[]).filter(a=>!a.internal && (a.family==='IPv4'||a.family===4));
    if(!ipv4.length || /^(docker|veth|br-|lo$|virbr|vmnet)/.test(name))continue;
    const tailscale=ipv4.some(a=>a.address.startsWith('100.') && +a.address.split('.')[1]>=64 && +a.address.split('.')[1]<=127);
    let kind=tailscale?'tailscale':/^thunderbolt/.test(name)?'thunderbolt':/^(wl|wifi)/.test(name)?'wifi':/^(eth|en)/.test(name)?'ethernet':'unknown';
    if(os==='darwin'&&!tailscale)kind='unknown'; // No guessed Wi-Fi/Thunderbolt kind on macOS.
    inventory.push({name,kind,speed_mbps:tailscale?null:os==='linux'?readSpeed(name):null,networks:tailscale?[]:ipv4.flatMap(a=>{ const parts=(a.cidr||'').split('/'),prefix=Number(parts[1]);if(parts.length!==2||!Number.isInteger(prefix)||prefix<0||prefix>32)return [];const value=a.address.split('.').reduce((n,b)=>(n*256+Number(b))>>>0,0),mask=prefix===0?0:(0xffffffff << (32-prefix))>>>0;const net=(value&mask)>>>0;return [[24,16,8,0].map(shift=>(net>>>shift)&255).join('.')+'/'+prefix];}),measured_at:measuredAt});
  }
  const links=[];
  for(const peer of peers) {
    if(!/^[a-zA-Z0-9_-]+$/.test(peer.id||'') || isIP(peer.address)!==4)throw Error('Peer requires slot id and literal IPv4');
    if(os!=='linux')continue;
    const output=command('ip',['-j','route','get',peer.address]);let route;
    try{route=JSON.parse(output)[0];}catch{continue;}
    const iface=inventory.find(i=>i.name===route?.dev);if(!iface)continue;
    links.push({peer_id:peer.id,local_interface:iface.name,remote_interface:null,route:iface.kind==='tailscale'?'tailscale':'lan',observed_at:measuredAt,evidence:'ip-route-get'});
  }
  return {interfaces:inventory,links,collected_at:measuredAt,collector:'iak-network-v1'};
}
export function mergeNetwork(previous={}, collected) {
  // Preserve independent measured transfers; route collection is not a bandwidth test.
  const old=Array.isArray(previous.links)?previous.links:[];
  const links=collected.links.map(r=>{
    const prior=old.find(o=>o.peer_id===r.peer_id);
    if(!prior?.measurement)return r;
    const samePath=(prior.measurement_route||prior.route)===r.route && prior.local_interface===r.local_interface;
    if(!samePath)return {...r,measurement_stale:true,previous_measurement_route:prior.measurement_route||prior.route||'unknown'};
    return {...r,measurement:prior.measurement,measurement_route:prior.measurement_route||prior.route};
  });
  // A collection is a complete current route inventory, not an append-only log.
  return {...previous,...collected,links};
}
export async function publishNetwork(c, collected, {fetchImpl=fetch}={}) {
  if(c.baseUrl!=='https://groupmind.one/api/v1')throw Error('Unsupported publish destination');
  for(const k of ['userId','deviceId'])if(!/^[a-zA-Z0-9_-]+$/.test(c[k]||''))throw Error('Invalid intent identifier');
  const key=(await import('node:fs/promises')).readFile;
  const token=(await key(c.keyFile,'utf8')).trim();
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json','Cache-Control':'no-cache'};
  const endpoint=`${c.baseUrl}/intent/${encodeURIComponent(c.userId)}`;
  const existing=await fetchImpl(endpoint,{headers,signal:AbortSignal.timeout(15000)});
  if(!existing.ok)throw Error(`Intent read HTTP ${existing.status}`);
  const intent=await existing.json(),slot=intent.devices?.[c.deviceId];
  if(!slot)throw Error('Existing device slot required; collector does not invent fleet identities');
  const network=mergeNetwork(slot.network,collected);
  const response=await fetchImpl(`${endpoint}/${encodeURIComponent(c.deviceId)}`,{method:'PATCH',headers,body:JSON.stringify({network}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`Intent publish HTTP ${response.status}`);
  return {deviceId:c.deviceId,interfaces:network.interfaces.length,links:network.links.length};
}
