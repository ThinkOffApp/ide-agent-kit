// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, resolveSecretFiles } from '../src/config.mjs';

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

  it('preserves intent, memory_api, and moltbook pass-through blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-config-'));
    tempPaths.push(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      intent: { baseUrl: 'https://example.test/api/v1', apiKey: 'k', userId: 'u' },
      memory_api: { baseUrl: 'https://mem.test', token: 't' },
      moltbook: { accounts: [{ name: 'claudemm', api_key: 'mk' }] }
    }));

    const cfg = loadConfig(configPath);

    assert.equal(cfg.intent.baseUrl, 'https://example.test/api/v1');
    assert.equal(cfg.intent.userId, 'u');
    assert.equal(cfg.memory_api.token, 't');
    assert.equal(cfg.moltbook.accounts[0].name, 'claudemm');
  });
});

describe('secret file references (issue #86)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('reads poller.api_key_file into poller.api_key, trimmed', () => {
    dir = mkdtempSync(join(tmpdir(), 'iak-secret-'));
    writeFileSync(join(dir, 'key.txt'), '  xfb_secret_from_file\n');
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ poller: { rooms: 'r', handle: '@x', api_key_file: join(dir, 'key.txt') } }));
    const cfg = loadConfig(join(dir, 'c.json'));
    assert.equal(cfg.poller.api_key, 'xfb_secret_from_file');
  });

  it('covers dm_poller, xfor and intent too', () => {
    dir = mkdtempSync(join(tmpdir(), 'iak-secret-'));
    writeFileSync(join(dir, 'k'), 'K1');
    const cfg = loadConfig(join(dir, 'c.json'));
    assert.equal(cfg.poller.api_key, '');
    writeFileSync(join(dir, 'c.json'), JSON.stringify({
      dm_poller: { api_key_file: join(dir, 'k') },
      xfor: { api_key_file: join(dir, 'k') },
      intent: { api_key_file: join(dir, 'k') }
    }));
    const c2 = loadConfig(join(dir, 'c.json'));
    assert.equal(c2.dm_poller.api_key, 'K1');
    assert.equal(c2.xfor.api_key, 'K1');
    assert.equal(c2.intent.apiKey, 'K1');
  });

  it('an inline key wins over the file, and a missing file names its path', () => {
    dir = mkdtempSync(join(tmpdir(), 'iak-secret-'));
    writeFileSync(join(dir, 'k'), 'FILEKEY');
    const both = resolveSecretFiles({ poller: { api_key: 'INLINE', api_key_file: join(dir, 'k') } });
    assert.equal(both.poller.api_key, 'INLINE');
    assert.throws(() => resolveSecretFiles({ poller: { api_key_file: join(dir, 'nope') } }), /secret file not found: .*nope/);
    writeFileSync(join(dir, 'empty'), '\n');
    assert.throws(() => resolveSecretFiles({ poller: { api_key_file: join(dir, 'empty') } }), /secret file is empty/);
  });
});
