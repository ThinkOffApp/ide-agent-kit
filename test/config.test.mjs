// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';

const tempPaths = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    rmSync(path, { recursive: true, force: true });
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

  it('default config has background section', () => {
    const cfg = loadConfig('/tmp/iak-nonexistent-config.json');
    assert.equal(cfg.background.enabled, false);
    assert.equal(cfg.background.recent_window_sec, 7200);
    assert.equal(cfg.background.max_events, 100);
    assert.equal(cfg.background.timeouts.light_sec, 60);
  });

  it('merges partial poller, dm_poller, and background config with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-config-'));
    tempPaths.push(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      poller: {
        rooms: ['thinkoff-development'],
        handle: '@CodexMB'
      },
      dm_poller: {
        enabled: true
      },
      background: {
        enabled: true,
        timeouts: { rem_sec: 90 }
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
    assert.equal(cfg.background.enabled, true);
    assert.equal(cfg.background.recent_window_sec, 7200);
    assert.equal(cfg.background.max_events, 100);
    assert.equal(cfg.background.timeouts.light_sec, 60);
    assert.equal(cfg.background.timeouts.rem_sec, 90);
  });
});
