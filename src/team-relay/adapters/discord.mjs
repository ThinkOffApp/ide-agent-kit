// SPDX-License-Identifier: AGPL-3.0-only
//
// RE-EXPORT SHIM - the canonical implementation lives in src/adapters/.
// This file used to be a full COPY, and the two trees drifted: the CLI
// imported this stale copy, so fixes landed in src/adapters/ (e.g. the
// reply-target work, PR #72) never reached the running poller. Discovered
// 27 Aug 2026, the same day the same disease was found in the webhook
// servers. One implementation, importable from both historical paths.
export { discordAdapter } from '../../adapters/discord.mjs';
