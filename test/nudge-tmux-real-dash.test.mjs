// Leading-dash payload must land as text on a real tmux, not as an option.
// Private socket only. Does not touch the default server or live sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nudgeTmux } from '../src/common/notify.mjs';

function haveTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('leading-dash text arrives on a private tmux server', { skip: haveTmux() ? false : 'tmux not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-tmux-dash-'));
  const socket = join(dir, 'tmux.sock');
  const oldTmux = process.env.TMUX;
  let started = false;
  try {
    execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'iakdash', '/bin/cat'], {
      stdio: 'ignore',
    });
    started = true;
    const pid = execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
    process.env.TMUX = `${socket},${pid},0`;

    const ok = nudgeTmux('iakdash', '-literal-text', { delayMs: 0 });
    assert.equal(ok, true);
    await delay(80);
    const pane = execFileSync('tmux', ['-S', socket, 'capture-pane', '-p', '-t', 'iakdash'], { encoding: 'utf8' });
    assert.match(pane, /-literal-text/);
  } finally {
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (started) {
      try {
        execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
