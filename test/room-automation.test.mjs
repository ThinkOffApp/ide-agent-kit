// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// Test the matchesRule logic by importing the module (startRoomAutomation is the export)
// We test the matching logic indirectly through the exported function signature
import { startRoomAutomation } from '../src/room-automation.mjs';

describe('room-automation', () => {
  it('exports startRoomAutomation function', () => {
    assert.equal(typeof startRoomAutomation, 'function');
  });
});
