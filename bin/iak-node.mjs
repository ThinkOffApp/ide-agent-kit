#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNode, startNode, systemdUnit } from '../src/node-service.mjs';
const [action, file] = process.argv.slice(2);
if (!['run','plan','install'].includes(action) || !file) throw Error('Usage: iak-node <plan|install|run> /absolute/node.json');
const configPath = resolve(file), c = validateNode(JSON.parse(await readFile(configPath, 'utf8')));
if (action === 'run') await startNode(c);
else {
  const unit = systemdUnit(configPath, process.execPath, fileURLToPath(import.meta.url));
  if (action === 'plan') process.stdout.write(unit);
  else {
    if (process.platform !== 'linux') throw Error('User service installation requires Linux');
    const dest = resolve(homedir(), '.config/systemd/user', `iak-node-${c.id}.service`);
    await mkdir(dirname(dest), {recursive:true,mode:0o700});
    await writeFile(dest,unit,{flag:'wx',mode:0o600});
    console.log(`Created ${dest}. To start: systemctl --user daemon-reload && systemctl --user enable --now iak-node-${c.id}.service`);
    console.log('For boot without login, an administrator must enable linger for this user.');
  }
}
