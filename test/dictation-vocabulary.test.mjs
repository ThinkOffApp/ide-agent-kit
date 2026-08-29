// The vocabulary file is loaded by CodeWatch (Android) and the car, so a
// broken pattern there breaks dictation on every surface at once. These tests
// guard the two properties that matter: every correction actually fixes the
// mishearing it claims to, and no correction damages ordinary speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vocab = JSON.parse(readFileSync(new URL('../packages/user-intent-kit/data/dictation-vocabulary.json', import.meta.url)));

const apply = (text) => vocab.corrections.reduce(
  (s, c) => s.replace(new RegExp(c.pattern, c.flags.includes('g') ? c.flags : c.flags + 'g'), c.replacement),
  text);

test('every correction is documented and compiles', () => {
  for (const c of vocab.corrections) {
    assert.ok(c.why && c.why.length > 20, `correction ${c.pattern} needs a why`);
    assert.doesNotThrow(() => new RegExp(c.pattern, c.flags));
  }
});

test('fixes the mishearings actually observed', () => {
  assert.equal(apply('these speeds to text this crap'), 'these speech to text this crap');
  assert.equal(apply('this piece to text is extremely bad'), 'this speech to text is extremely bad');
  assert.equal(apply('can I fill up with eating gas'), 'can I fill up with E10 gas');
  assert.equal(apply('what about e ten gasoline'), 'what about E10 gasoline');
  assert.equal(apply('open code watch'), 'open CodeWatch');
});

test('leaves ordinary speech alone', () => {
  // The whole point of the bias/correction split: real words survive.
  for (const safe of [
    'the warehouse is closed',           // how "Wear OS" came out, but a real word
    'I was eating lunch',                // "eating" without a fuel word
    'she baked a raspberry pie for us',  // dessert: bias may help, a rewrite must not
    'peace talks resumed',               // near-miss of the speech-to-text rule
    'ten of them arrived',
  ]) {
    assert.equal(apply(safe), safe, `corrupted ordinary speech: ${safe}`);
  }
});
