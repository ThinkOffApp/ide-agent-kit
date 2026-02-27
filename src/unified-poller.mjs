// SPDX-License-Identifier: AGPL-3.0-only

import { loadSeenIds, saveSeenIds } from './common/seen-ids.mjs';
import { nudgeTmux, writeNotification } from './common/notify.mjs';
import { appendEvents } from './common/event-queue.mjs';
import { appendFileSync } from 'node:fs';

/**
 * UnifiedPoller — runs any PlatformAdapter on a polling loop with
 * deduplication, event queuing, receipt logging, rate limiting, and notifications.
 *
 * Each adapter implements:
 *   name        — string identifier (e.g. 'antfarm', 'xfor')
 *   fetch(cfg)  — returns raw messages from the platform
 *   getKey(msg) — returns a unique dedup key for a message
 *   normalize(msg, ctx) — returns a normalized event object
 *   shouldSkip(msg, cfg) — returns true if message should be filtered
 *   formatLine(event) — returns a human-readable notification line
 */

export class UnifiedPoller {
  constructor(adapter, config) {
    this.adapter = adapter;
    this.config = config;
    this.timer = null;

    const name = adapter.name;
    const adapterCfg = config?.[name] || config?.poller || {};

    this.seenFile = adapterCfg.seen_file || `/tmp/iak-${name}-seen.txt`;
    this.maxSeenIds = adapterCfg.max_seen_ids || 2000;
    this.queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
    this.notifyFile = adapterCfg.notification_file || config?.poller?.notification_file || '/tmp/iak-new-messages.txt';
    this.receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';
    this.session = config?.tmux?.ide_session || 'claude';
    this.nudgeText = config?.tmux?.nudge_text || 'check rooms';
    this.interval = adapterCfg.interval_sec || 30;

    this.seen = loadSeenIds(this.seenFile, this.maxSeenIds);
  }

  /**
   * One-shot poll: fetch, dedup, normalize, queue, notify.
   * Returns array of new events.
   */
  async poll() {
    let messages;
    try {
      messages = await this.adapter.fetch(this.config);
    } catch (e) {
      console.error(`  ${this.adapter.name} fetch error: ${e.message}`);
      this.logReceipt({ action: 'fetch', status: 'error', error: e.message });
      return [];
    }

    const newEvents = [];
    const lines = [];

    for (const msg of messages) {
      const key = this.adapter.getKey(msg);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);

      if (this.adapter.shouldSkip(msg, this.config)) continue;

      const event = this.adapter.normalize(msg, this.config);
      if (!event) continue;

      newEvents.push(event);
      lines.push(this.adapter.formatLine(event));
    }

    saveSeenIds(this.seenFile, this.seen, this.maxSeenIds);

    if (newEvents.length > 0) {
      appendEvents(this.queuePath, newEvents);
      writeNotification(this.notifyFile, lines);

      const nudged = nudgeTmux(this.session, this.nudgeText);
      console.log(`  ${this.adapter.name}: ${newEvents.length} new event(s)${nudged ? ' + tmux nudge' : ''}`);

      this.logReceipt({
        action: 'poll',
        status: 'ok',
        count: newEvents.length,
        source: this.adapter.name
      });
    }

    return newEvents;
  }

  /**
   * Seed seen IDs from current platform state (first run).
   */
  async seed() {
    if (this.seen.size > 0) return;

    console.log(`  ${this.adapter.name}: seeding seen IDs...`);
    let messages;
    try {
      messages = await this.adapter.fetch(this.config, { seed: true });
    } catch (e) {
      console.error(`  ${this.adapter.name} seed error: ${e.message}`);
      return;
    }

    for (const msg of messages) {
      const key = this.adapter.getKey(msg);
      if (key) this.seen.add(key);
    }
    saveSeenIds(this.seenFile, this.seen, this.maxSeenIds);
    console.log(`  ${this.adapter.name}: seeded ${this.seen.size} IDs`);
  }

  /**
   * Start long-running polling loop.
   */
  async start() {
    console.log(`${this.adapter.name} poller started`);
    console.log(`  interval: ${this.interval}s`);
    console.log(`  seen file: ${this.seenFile}`);
    console.log(`  queue: ${this.queuePath}`);

    await this.seed();
    await this.poll();

    this.timer = setInterval(() => this.poll(), this.interval * 1000);

    const shutdown = () => {
      console.log(`\n${this.adapter.name} poller stopped.`);
      if (this.timer) clearInterval(this.timer);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return this.timer;
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Log a receipt for audit trail.
   */
  logReceipt(data) {
    try {
      const receipt = {
        timestamp: new Date().toISOString(),
        adapter: this.adapter.name,
        ...data
      };
      appendFileSync(this.receiptPath, JSON.stringify(receipt) + '\n');
    } catch { /* best-effort */ }
  }
}
