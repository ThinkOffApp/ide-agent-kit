// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('config', () => {
  it('loadConfig returns defaults when no file exists', () => {
    const cfg = loadConfig('/tmp/iak-nonexistent-config.json');
    assert.ok(cfg.listen);
    assert.ok(cfg.queue);
    assert.ok(cfg.receipts);
    assert.ok(cfg.tmux);
    assert.ok(cfg.poller);
    assert.ok(cfg.dm_poller);
    assert.ok(cfg.automation);
    assert.ok(cfg.comments);
  });

  it('default config has automation section', () => {
    const cfg = loadConfig('/tmp/iak-nonexistent-config.json');
    assert.ok(Array.isArray(cfg.automation.rules));
    assert.equal(cfg.automation.rules.length, 0);
    assert.equal(cfg.automation.interval_sec, 30);
    assert.equal(cfg.automation.cooldown_sec, 5);
    assert.equal(cfg.automation.first_match_only, true);
  });

  it('default config has comments section', () => {
    const cfg = loadConfig('/tmp/iak-nonexistent-config.json');
    assert.ok(Array.isArray(cfg.comments.moltbook.posts));
    assert.ok(Array.isArray(cfg.comments.github.repos));
    assert.equal(cfg.comments.interval_sec, 120);
  });

  it('merges partial poller and dm_poller config with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      poller: {
        rooms: ['thinkoff-development'],
        handle: '@CodexMB'
      },
      dm_poller: {
        enabled: true
      }
    }));

    const cfg = loadConfig(configPath);

    assert.deepEqual(cfg.poller.rooms, ['thinkoff-development']);
    assert.equal(cfg.poller.handle, '@CodexMB');
    assert.equal(cfg.poller.interval_sec, 30);
    assert.equal(cfg.poller.seen_file, '/tmp/iak-seen-ids.txt');
    assert.equal(cfg.dm_poller.enabled, true);
    assert.equal(cfg.dm_poller.interval_sec, 30);
    assert.equal(cfg.dm_poller.seen_file, '/tmp/iak-dm-seen-ids.txt');
    assert.equal(cfg.dm_poller.limit, 100);
  });
});
