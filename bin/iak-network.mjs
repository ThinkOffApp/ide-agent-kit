#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import {readFile} from 'node:fs/promises';
import {collectNetwork,publishNetwork} from '../src/network-collector.mjs';
const [configFile,action='collect']=process.argv.slice(2);
if(!configFile||!['collect','publish'].includes(action))throw Error('Usage: iak-network /absolute/config.json [collect|publish]');
const config=JSON.parse(await readFile(configFile,'utf8'));
const network=collectNetwork({peers:config.peers||[]});
console.log(JSON.stringify(action==='publish'?await publishNetwork(config,network):network,null,2));
