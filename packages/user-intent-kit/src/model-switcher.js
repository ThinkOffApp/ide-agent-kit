// SPDX-License-Identifier: AGPL-3.0
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const normalizeModelName = name => typeof name === 'string'
  ? name.trim().split('/').pop().replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '') : '';

/** Optional local chooser bridge. Never sends the intent key to the chooser.
 * Claims are durable BEFORE dispatch. An uncertain dispatch is reconciled,
 * never replayed: exactly-once side effects cannot be promised by HTTP.
 */
export class ModelSwitcher {
  #client; #url; #file; #brain; #fetch; #now; #timeout; #busy = false;
  #records; #timer; #fields; #warn; #lastWarning = -Infinity;
  constructor(client, {
    chooserUrl = process.env.INTENT_CHOOSER_URL,
    brainOf = process.env.INTENT_DEVICE_BRAIN_OF || '',
    stateFile = process.env.INTENT_SWITCH_STATE_FILE || join(homedir(), '.local', 'state', 'user-intent-kit',
      `switch-${encodeURIComponent(client.userId)}-${encodeURIComponent(client.deviceId)}.json`),
    fetchImpl = fetch, now = Date.now, timeoutMs = 15 * 60 * 1000, warn = console.warn,
  } = {}) {
    this.#client = client; this.#brain = brainOf; this.#file = stateFile;
    this.#fetch = fetchImpl; this.#now = now; this.#timeout = timeoutMs;
    this.#warn = warn;
    if (chooserUrl) {
      const u = new URL(chooserUrl);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
        throw new Error('Invalid INTENT_CHOOSER_URL');
      this.#url = u.href.replace(/\/+$/, '');
    }
    this.#fields = this.#down();
  }
  get enabled() { return !!this.#url; }
  #down() { return { model_catalog: [], model: null, model_state: 'down', brain_of: this.#brain }; }
  fields() { return this.enabled ? structuredClone(this.#fields) : {}; }
  #warning(reason) {
    const now = this.#now();
    if (now >= this.#lastWarning && now - this.#lastWarning < 300000) return;
    this.#lastWarning = now;
    // Fixed diagnostics only: never log URLs, keys, response bodies or model paths.
    this.#warn(`uik model switcher: ${reason}`);
  }
  async #registry() {
    try { return await this.#readRegistry(); }
    catch (error) { this.#warning('local chooser unavailable or invalid; no new switch dispatched'); throw error; }
  }
  async #readRegistry() {
    const response = await this.#fetch(`${this.#url}/api/models`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Chooser unavailable');
    const r = await response.json();
    if (!Array.isArray(r.models) || !['ready', 'loading', 'down'].includes(r.state))
      throw new Error('Invalid chooser registry');
    this.#fields = {
      model_catalog: r.models.filter(m => m && typeof m.name === 'string' && m.name.trim()).map(m => ({
        name: m.name, size_gb: Number.isFinite(m.size_gb) ? m.size_gb : null,
        params_label: typeof m.params_label === 'string' ? m.params_label : null, fits: m.fits === true,
      })),
      model: typeof r.running === 'string' ? r.running : null,
      model_state: r.state, brain_of: this.#brain,
    };
    return r;
  }
  async refresh() {
    if (!this.enabled) return {};
    try { await this.#registry(); } catch { this.#fields = this.#down(); }
    return this.fields();
  }
  async #load() {
    if (this.#records) return;
    try {
      const data = JSON.parse(await readFile(this.#file, 'utf8'));
      if (data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records))
        throw new Error('Invalid switch state');
      const records = new Map(Object.entries(data.records));
      for (const record of records.values()) {
        if (!record || typeof record.model !== 'string' || !Number.isFinite(record.started) ||
            !['claimed', 'dispatched', 'done', 'failed', 'expired'].includes(record.status))
          throw new Error('Invalid switch state record');
      }
      this.#records = records;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#warning('state file unreadable or corrupt; switching paused (preserve the file for inspection)');
        throw error; // corrupt/unreadable state fails closed
      }
      this.#records = new Map();
    }
  }
  async #save(id, record) {
    // Do not update the in-memory claim until persistence succeeds.
    const next = new Map(this.#records); next.set(id, record);
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const file = await open(tmp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, records: Object.fromEntries(next) }));
      await file.sync();
    } finally { await file.close(); }
    await rename(tmp, this.#file);
    const directory = await open(dirname(this.#file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    this.#records = next;
  }
  async #finish(id, record, status, detail) {
    const terminal = { ...record, status, detail };
    await this.#save(id, terminal); // retain report even if PATCH is unavailable
    await this.#client.reportModelSwitch({ id, status, ...(detail === undefined ? {} : { detail }) });
  }
  async poll() {
    if (!this.enabled || this.#busy) return;
    this.#busy = true;
    try {
      await this.#load();
      const { request: req } = await this.#client.getModelSwitch();
      if (!req || typeof req.id !== 'string' || !req.id || typeof req.model !== 'string') return;
      let record = this.#records.get(req.id);
      if (['done', 'failed'].includes(req.status) || (req.status === 'expired' && record?.status === 'expired')) return;
      if (record && ['done', 'failed', 'expired'].includes(record.status)) {
        await this.#client.reportModelSwitch({ id: req.id, status: record.status, detail: record.detail });
        return;
      }
      if (!record) {
        if (!['pending', 'expired'].includes(req.status)) return; // never adopt an unknown running command
        const filed = Date.parse(req.requested_at);
        record = { model: req.model, started: this.#now(), status: 'claimed' };
        if (req.status === 'expired' || !Number.isFinite(filed) || this.#now() - filed > 600000 || filed > this.#now() + 60000)
          return await this.#finish(req.id, record, 'expired', 'Request expired');
        const registry = await this.#registry(); // current LOCAL catalog, not the server's list
        const matches = registry.models.filter(m => normalizeModelName(m?.name) === normalizeModelName(req.model));
        const pick = matches.length === 1 ? matches[0] : null;
        if (!pick || pick.fits !== true)
          return await this.#finish(req.id, record, 'failed', 'Model is not in the local fitting catalog');
        if (registry.state === 'ready' && normalizeModelName(registry.running) === normalizeModelName(pick.name))
          return await this.#finish(req.id, record, 'done', 'already running');
        await this.#save(req.id, record);
        // If this PATCH fails/has an uncertain result, no local POST is made.
        await this.#client.reportModelSwitch({ id: req.id, status: 'running' });
        await this.#save(req.id, { ...record, status: 'dispatched' });
        let response;
        try {
          response = await this.#fetch(`${this.#url}/api/model`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pick.name }), signal: AbortSignal.timeout(70000),
          });
        } catch {
          this.#warning('chooser dispatch response uncertain; reconciling without replay');
          return; // reconcile later; NEVER retry an uncertain POST
        }
        const body = await response.text();
        if (!response.ok) return await this.#finish(req.id, record, 'failed', body);
        let result;
        try { result = JSON.parse(body); } catch { return; }
        if (result.ok !== true) return await this.#finish(req.id, record, 'failed', body);
        return; // readiness checked on the independent next 15s poll
      }
      if (req.status === 'pending')
        return await this.#finish(req.id, record, 'failed', 'Interrupted before dispatch; not replayed');
      if (req.status !== 'running') return;
      let registry;
      try { registry = await this.#registry(); } catch { /* transient outage until deadline */ }
      if (registry?.state === 'ready' && normalizeModelName(registry.running) === normalizeModelName(record.model))
        return await this.#finish(req.id, record, 'done');
      if (this.#now() - record.started >= this.#timeout)
        await this.#finish(req.id, record, 'failed', 'Timed out waiting for the requested model to be ready; not replayed');
    } catch (error) {
      this.#warning('poll/report or state persistence failed; switching fails closed without dispatch replay');
      throw error;
    } finally { this.#busy = false; }
  }
  start() {
    this.stop();
    if (!this.enabled) return;
    this.poll().catch(() => {});
    this.#timer = setInterval(() => this.poll().catch(() => {}), 15000);
    this.#timer.unref?.();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
}
