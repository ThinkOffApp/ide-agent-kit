// SPDX-License-Identifier: AGPL-3.0-only
//
// "Was this module run directly, or imported?" - ONE implementation.
//
// Getting this wrong is silent, and silence from a guard is the worst kind of
// bug: the script starts, does nothing, and exits 0. For a security tool that
// reads as "clean".
//
// The trap is that `import.meta.url` is ALWAYS realpath-resolved by node, and
// `process.argv[1]` never is. So every one of these is broken through a
// symlink:
//
//   import.meta.url === `file://${process.argv[1]}`            // and spaces
//   import.meta.url === pathToFileURL(process.argv[1]).href
//   path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
//
// On macOS /tmp IS a symlink to /private/tmp, so every scratch dir, every
// worktree under /tmp and every ~/bin symlink hits it, as does a CI checkout
// in a symlinked workspace. This repo hit the same bug three times in one day
// in three different files before anyone swept for it, which is why the
// comparison now lives in exactly one place with a test that fails if a new
// entry point rolls its own.
//
// Resolve BOTH sides to a real path and compare those.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `importMetaUrl`'s module is the script node was asked to run.
 *
 * @param {string} importMetaUrl - always pass `import.meta.url`.
 */
export function isMainModule(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    // argv[1] gone, unreadable, or not a path at all. Not a main-module run.
    return false;
  }
}
