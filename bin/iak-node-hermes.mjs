#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { hermesReceipt } from '../src/node-hermes.mjs';
const [configFile, action] = process.argv.slice(2);
try {
 let input='';for await (const chunk of process.stdin) {input+=chunk;if(input.length>1048576)throw Error('Input too large');}
 const config=JSON.parse(await readFile(configFile,'utf8'));
 console.log(JSON.stringify(await hermesReceipt(config,action,JSON.parse(input))));
} catch { console.error('Hermes node adapter failed; delivery remains pending');process.exitCode=1; }
