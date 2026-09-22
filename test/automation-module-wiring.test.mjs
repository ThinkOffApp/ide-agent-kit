// The room automation exists TWICE under the same filename:
//   src/room-automation.mjs              the one the tests import
//   src/team-relay/room-automation.mjs   the one bin/cli.mjs used to import
//
// On 2026-09-18 the /lead chat command was written into the first and the
// watcher loaded the second. Every unit test passed, the daemon answered, the
// process was restarted -- and petrus got silence twice, because the handler
// was in a file nothing loaded. A green suite against an unloaded module is
// not evidence about the product.
//
// This test asserts the entry points and the tests agree on WHICH module runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('bin/cli.mjs loads the room-automation module that exports the /lead handler', async () => {
  const cli = read('bin/cli.mjs');
  const m = /import\s*\{[^}]*startRoomAutomation[^}]*\}\s*from\s*'([^']+)'/.exec(cli);
  assert.ok(m, 'cli.mjs does not import startRoomAutomation at all');
  const spec = m[1];

  // Resolve what cli.mjs actually loads, and require the handler to be in it.
  const mod = await import(new URL(spec.replace(/^\.\.\//, '../'), import.meta.url).href)
    .catch(async () => import(join(root, spec.replace(/^\.\.\//, ''))));
  assert.ok(
    typeof mod.handleLeadCommand === 'function',
    `cli.mjs imports ${spec}, which does not export handleLeadCommand — ` +
    'the chat command would be unreachable no matter how many tests pass',
  );
});

test('every re-export of startRoomAutomation points at the same module', () => {
  const cli = read('bin/cli.mjs');
  const idx = read('src/team-relay/index.mjs');
  const specOf = (src) => (/startRoomAutomation[^}]*\}\s*from\s*'([^']+)'/.exec(src) || [])[1];
  const a = specOf(cli);
  const b = specOf(idx);
  assert.ok(a && b, 'could not find both specifiers');
  // Different relative depths, same target file.
  const norm = (s) => s.replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^src\//, '');
  assert.equal(
    norm(a), norm(b),
    `bin/cli.mjs loads ${a} but src/team-relay/index.mjs re-exports ${b} — ` +
    'two entry points, two different modules, is exactly how /lead was lost',
  );
});
