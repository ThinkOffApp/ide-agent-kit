// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBackground, backgroundStatus } from '../src/background.mjs';

const tempPaths = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    rmSync(path, { recursive: true, force: true });
  }
});

function makeConfig(dir) {
  return {
    queue: { path: join(dir, 'queue.jsonl') },
    background: {
      enabled: true,
      interval_sec: 3600,
      recent_window_sec: 7200,
      max_events: 100,
      sidecar_dir: join(dir, 'sidecars'),
      lock_file: join(dir, 'background.lock'),
      timeouts: {
        light_sec: 60,
        rem_sec: 120,
        deep_sec: 120
      }
    }
  };
}

describe('background consolidation', () => {
  it('writes sequential light/REM/deep sidecars for a recent queue window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-background-'));
    tempPaths.push(dir);
    const config = makeConfig(dir);
    const events = [
      {
        event_id: 'evt-1',
        timestamp: '2026-04-06T17:00:00.000Z',
        room: 'thinkoff-development',
        actor: { login: 'petrus' },
        kind: 'groupmind.message.created',
        source: 'groupmind',
        payload: { body: 'Please update README and review the plan.' }
      },
      {
        event_id: 'evt-2',
        timestamp: '2026-04-06T17:10:00.000Z',
        room: 'thinkoff-development',
        actor: { login: '@claudemm' },
        kind: 'groupmind.message.created',
        source: 'groupmind',
        payload: { body: 'The plan should keep foreground replies reactive.' }
      }
    ];
    writeFileSync(config.queue.path, events.map(event => JSON.stringify(event)).join('\n') + '\n');

    const result = runBackground(config, {
      now: '2026-04-06T18:00:00.000Z',
      runId: 'run-1'
    });

    assert.equal(result.ok, true);
    assert.equal(result.sidecars.length, 3);
    result.sidecars.forEach(path => assert.equal(existsSync(path), true));

    const light = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-1-light.json'), 'utf8'));
    const rem = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-1-REM.json'), 'utf8'));
    const deep = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-1-deep.json'), 'utf8'));

    assert.equal(light.status, 'ok');
    assert.equal(light.output.items.length, 2);
    assert.equal(rem.status, 'ok');
    assert.ok(rem.output.follow_ups.length >= 1);
    assert.equal(deep.status, 'ok');
    assert.ok(Array.isArray(deep.output.facts));
  });

  it('skips light/REM/deep when there are no new events since the last run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-background-'));
    tempPaths.push(dir);
    const config = makeConfig(dir);
    const events = [
      {
        event_id: 'evt-1',
        timestamp: '2026-04-06T17:00:00.000Z',
        room: 'thinkoff-development',
        actor: { login: 'petrus' },
        kind: 'groupmind.message.created',
        source: 'groupmind',
        payload: { body: 'Please update README and review the plan.' }
      }
    ];
    writeFileSync(config.queue.path, events.map(event => JSON.stringify(event)).join('\n') + '\n');

    runBackground(config, {
      now: '2026-04-06T18:00:00.000Z',
      runId: 'run-1'
    });
    const result = runBackground(config, {
      now: '2026-04-06T18:30:00.000Z',
      runId: 'run-2'
    });

    assert.equal(result.ok, true);
    const light = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-2-light.json'), 'utf8'));
    const rem = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-2-REM.json'), 'utf8'));
    const deep = JSON.parse(readFileSync(join(config.background.sidecar_dir, 'run-2-deep.json'), 'utf8'));

    assert.equal(light.status, 'skipped');
    assert.equal(rem.status, 'skipped');
    assert.equal(deep.status, 'skipped');
  });

  it('reports background status with latest sidecar path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iak-background-'));
    tempPaths.push(dir);
    const config = makeConfig(dir);
    writeFileSync(config.queue.path, '');

    runBackground(config, {
      now: '2026-04-06T18:00:00.000Z',
      runId: 'run-1'
    });

    const status = backgroundStatus(config);
    assert.equal(status.enabled, true);
    assert.equal(status.lock_active, false);
    assert.ok(status.latest_sidecar.endsWith('.json'));
  });
});
