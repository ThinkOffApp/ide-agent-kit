// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadConfig } from '../src/config.mjs';

describe('config', () => {
  it('loadConfig returns defaults when no file exists', () => {
    const cfg = loadConfig('/tmp/iak-nonexistent-config.json');
    assert.ok(cfg.listen);
    assert.ok(cfg.queue);
    assert.ok(cfg.receipts);
    assert.ok(cfg.tmux);
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
});
