#!/usr/bin/env node
// action-request.mjs — ClaudeMB's structured-action poster (the "request" side
// of the broad-capability/button-gated model agreed with ether + petrus on
// 2026-06-19 in thinkoff-development).
//
// This is ONLY the requester. It posts a typed action intent to the IAK daemon
// and waits for the daemon's receipt. It NEVER runs the prod command itself:
// the daemon validates the target against its registry, shows petrus a CodeWatch
// approval button, verifies his approval, runs the registered executor, and
// writes the receipt. So nothing in ClaudeMB's harness is loosened and no
// deploy permission is self-granted — the privileged execution lives entirely
// in the daemon (ether's lane).
//
// Contract (ether, msg cd57263d):
//   POST /actions/request  body: { type, target, requested_by, decision_room,
//                                   receipt_room, nonce, expires_at, risk }
//                          -> { ok, id, nonce, status: "pending" }
//   GET  /actions/{nonce}  -> { ...status/receipt }
//
// Usage:
//   node scripts/action-request.mjs merge_pr --repo ThinkOffApp/antfarm --pr 38
//   node scripts/action-request.mjs deploy_site --project codewatch-web
//   node scripts/action-request.mjs upload_play_internal --version-code 56
//   node scripts/action-request.mjs install_debug_apk --version-code 56 --device <serial>
// Options: --daemon <url> (default http://127.0.0.1:8788 or $IAK_DAEMON),
//          --risk low|medium|high, --ttl <minutes> (default 15),
//          --decision-room <room> (default thinkoff-development),
//          --no-wait (post and exit without polling for the receipt).

import { randomUUID } from 'node:crypto';

const REQUESTED_BY = '@claudeMB';
const DEFAULT_ROOM = 'thinkoff-development';
const DEFAULT_DAEMON = process.env.IAK_DAEMON || 'http://127.0.0.1:8788';
const POLL_MS = 3000;

// Client-side mirror of the daemon's registry. The daemon re-validates
// authoritatively; this just avoids bothering petrus with a malformed request
// and documents exactly what each action type accepts.
const REGISTRY = {
  merge_pr: {
    risk: 'medium',
    build(o) {
      const ALLOWED = ['ThinkOffApp/antfarm', 'ThinkOffApp/xfor', 'ThinkOffApp/codewatch-site'];
      const repo = o.repo;
      const pr = Number(o.pr);
      const base = o.base || 'main';
      if (!ALLOWED.includes(repo)) throw new Error(`repo must be one of ${ALLOWED.join(', ')}`);
      if (!Number.isInteger(pr) || pr <= 0) throw new Error('--pr must be a positive integer');
      if (base !== 'main') throw new Error('base must be "main"');
      return { repo, pr, base };
    },
    summary: (t) => `merge ${t.repo} PR #${t.pr} into ${t.base}`,
  },
  deploy_site: {
    risk: 'medium',
    build(o) {
      const ALLOWED = ['codewatch-web', 'groupmind'];
      const project = o.project;
      const ref = o.ref || 'main';
      if (!ALLOWED.includes(project)) throw new Error(`--project must be one of ${ALLOWED.join(', ')}`);
      if (ref !== 'main') throw new Error('ref must be "main"');
      return { project, ref };
    },
    summary: (t) => `deploy ${t.project} @ ${t.ref}`,
  },
  upload_play_internal: {
    risk: 'high',
    build(o) {
      const vc = Number(o['version-code']);
      if (!Number.isInteger(vc) || vc <= 0) throw new Error('--version-code must be a positive integer');
      // AAB file-pick stays petrus's for now; the executor for this lands after merge_pr.
      return { app_id: '4975875542898959486', track: 'internal', version_code: vc };
    },
    summary: (t) => `upload CodeWatch versionCode ${t.version_code} to Play ${t.track}`,
  },
  install_debug_apk: {
    risk: 'low',
    build(o) {
      const vc = Number(o['version-code']);
      if (!Number.isInteger(vc) || vc <= 0) throw new Error('--version-code must be a positive integer');
      if (!o.device) throw new Error('--device <adb serial> required');
      return { package: 'com.thinkoff.codewatch', version_code: vc, device: String(o.device) };
    },
    summary: (t) => `adb install CodeWatch versionCode ${t.version_code} to ${t.device}`,
  },
  // Catalog/product import into a Shopify store (the Garageland use-case,
  // 2026-06-19). The daemon's executor runs the API importer; the store + the
  // write_products token live with the executor, never in this requester. Always
  // draft unless the human explicitly approves an active import.
  import_products: {
    risk: 'high',
    build(o) {
      const store = o.store;     // e.g. garageland.myshopify.com
      const source = o.source;   // dataset id the executor resolves (e.g. garageland-fi)
      if (!store || !/\.myshopify\.com$/.test(String(store))) {
        throw new Error('--store <handle.myshopify.com> required');
      }
      if (!source) throw new Error('--source <dataset id> required');
      // Import is ALWAYS draft by design (ether, PR #16): publishing is a
      // separate action (a future publish_products) so an import can never
      // accidentally go live.
      return { store: String(store), source: String(source), status: 'draft' };
    },
    summary: (t) => `import products "${t.source}" into ${t.store} as draft`,
  },
};

function parseArgs(argv) {
  const type = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { opts[key] = true; }
      else { opts[key] = next; i++; }
    }
  }
  return { type, opts };
}

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const TERMINAL = new Set(['merged', 'deployed', 'uploaded', 'installed', 'imported', 'done', 'failed', 'denied', 'expired', 'error']);

async function main() {
  const { type, opts } = parseArgs(process.argv.slice(2));
  const spec = REGISTRY[type];
  if (!type || !spec) {
    console.error(`Unknown or missing action type. Valid: ${Object.keys(REGISTRY).join(', ')}`);
    console.error('Example: node scripts/action-request.mjs merge_pr --repo ThinkOffApp/antfarm --pr 38');
    process.exit(2);
  }

  let target;
  try { target = spec.build(opts); }
  catch (e) { console.error(`Invalid target for ${type}: ${e.message}`); process.exit(2); }

  const daemon = (opts.daemon || DEFAULT_DAEMON).replace(/\/$/, '');
  const nonce = randomUUID();
  const ttlMin = Number(opts.ttl) > 0 ? Number(opts.ttl) : 15;
  const expires_at = new Date(Date.now() + ttlMin * 60_000).toISOString();
  const decision_room = opts['decision-room'] || DEFAULT_ROOM;

  const intent = {
    type,
    target,
    requested_by: REQUESTED_BY,
    decision_room,
    receipt_room: opts['receipt-room'] || decision_room,
    nonce,
    expires_at,
    risk: opts.risk || spec.risk,
  };

  console.error(`Requesting: ${spec.summary(target)}  [risk=${intent.risk}, nonce=${nonce.slice(0, 8)}]`);

  const reqUrl = `${daemon}/actions/request`;
  let created;
  try {
    created = await jsonFetch(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
  } catch (e) {
    console.error(`Cannot reach daemon at ${reqUrl}: ${e.message}`);
    console.error('Is the IAK daemon running and has ether shipped POST /actions/request yet?');
    process.exit(1);
  }

  if (created.status === 404) {
    console.error(`Daemon has no /actions/request endpoint yet (404). The executor side (ether) is not live.`);
    process.exit(1);
  }
  if (created.status >= 400 || created.body.ok === false) {
    console.error(`Daemon rejected the request (${created.status}): ${JSON.stringify(created.body)}`);
    process.exit(1);
  }

  console.error(`Pending approval — petrus taps Approve on CodeWatch. id=${created.body.id || '?'} nonce=${nonce.slice(0, 8)}`);
  if (opts['no-wait']) {
    console.log(JSON.stringify({ requested: intent, response: created.body }, null, 2));
    return;
  }

  // Poll the receipt endpoint until the daemon reports a terminal status.
  const statusUrl = `${daemon}/actions/${nonce}`;
  // Local safety cap a bit past the intent TTL so we never poll forever.
  const deadline = Date.now() + (ttlMin * 60_000) + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let cur;
    try { cur = await jsonFetch(statusUrl, { method: 'GET' }); }
    catch (e) { console.error(`poll error: ${e.message}`); continue; }
    if (cur.status === 404) { console.error('receipt not found yet…'); continue; }
    const status = cur.body.status;
    if (status && TERMINAL.has(status)) {
      console.error(`Terminal: ${status}`);
      console.log(JSON.stringify(cur.body, null, 2));
      process.exit(status === 'failed' || status === 'denied' || status === 'expired' || status === 'error' ? 1 : 0);
    }
    console.error(`…${status || 'pending'}`);
  }
  console.error('Local poll deadline reached without a terminal receipt (intent likely expired).');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
