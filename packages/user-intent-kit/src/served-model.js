// SPDX-License-Identifier: AGPL-3.0

/**
 * What LLM is THIS machine serving, right now?
 *
 * The fleet dashboard already had a place for the answer and the API already
 * accepted it; nobody ever put it in the payload. This is the reporter.
 *
 * WHY A PROBE AND NOT A SETTING
 *
 * `INTENT_DEVICE_MODEL` exists and is honest about what it is: the operator's
 * statement, frozen at the moment the daemon started. It is right until
 * somebody restarts a server with different weights, and then it is a name on
 * a public dashboard that belongs to no running process. The env var cannot
 * know that it went wrong, so it keeps reporting, confidently, forever.
 *
 * An OpenAI-compatible server answers the question about itself, on every
 * poll, and stops answering the moment it stops serving. That is the reading
 * we want: a model swap shows up within one probe interval, and a server that
 * dies takes its label with it instead of leaving one behind.
 *
 * So the ranking is: what a server SAYS beats what a file says, and "we asked
 * and got no name" beats both - it publishes nothing.
 *
 * THE OMIT-NOT-FAKE CONTRACT, which is the whole point
 *
 * There is no "unknown", no empty string, no last-known-good. A machine that
 * is not serving publishes no `model` key at all and the dashboard renders a
 * card without a label, which is exactly right. The failure this module
 * exists to prevent is a wrong model name in a screenshot, and every
 * placeholder is a wrong model name waiting to be cropped into one.
 *
 * That rule is why a stale reading expires. If the probe itself breaks - a
 * bug here, a hung fetch, a machine that stops answering - `current()` goes
 * quiet after `staleAfterMs` rather than serving the last good answer until
 * the daemon restarts. A label that outlives its evidence is the exact defect
 * we are replacing.
 *
 * WHY NOT OLLAMA'S PORT BY DEFAULT
 *
 * Measured on this MacBook, 20 Sep 2026: Ollama on 11434 answers
 * `/v1/models` with `gpt-oss:20b`, while `/api/ps` - the models actually
 * resident - answers `{"models":[]}`. Ollama's OpenAI-compatible list is the
 * PULLED catalogue, not the loaded set, so defaulting to it would have this
 * machine announce a model it is not running. A pulled model is not a served
 * model. The default is 127.0.0.1:8080, the llama.cpp / vLLM convention that
 * the fleet already uses (m5 serves on 8080), where a listing means a loaded
 * server. Point INTENT_MODEL_ENDPOINT at Ollama deliberately if you want the
 * catalogue; nothing does it for you.
 *
 * COST
 *
 * The heartbeat is 30 s and the probe is NOT on it - it runs on its own
 * timer, 5 minutes by default (INTENT_MODEL_PROBE_MS). The heartbeat reads a
 * cached value and never awaits a socket. Two reasons, and the second is the
 * important one: a model swap is a human-scale event that does not need
 * 30 s resolution, and a probe on the heartbeat's own path can delay or fail
 * the heartbeat. A dashboard losing a whole machine because its LLM is down
 * is a worse bug than the one this file fixes.
 */

import { loadRegistry, probeServedModels, DEFAULT_TIMEOUT_MS } from './model-capacity.js';

/** Where a local model server listens when nobody says otherwise. */
export const DEFAULT_ENDPOINT = '127.0.0.1:8080';

/** The probe's own interval: slower than the heartbeat, on purpose. */
export const DEFAULT_PROBE_INTERVAL_MS = 300000;

/** One socket's worth of patience. Loopback; a slow answer is a broken one. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000;

/** Values of INTENT_MODEL_ENDPOINT that mean "do not probe at all". */
const DISABLED = new Set(['0', 'off', 'none', 'no', 'disabled', 'false']);

/**
 * Why we are publishing what we are publishing. Exported because the daemon
 * logs it and the tests assert on it: "no model" has four different causes
 * and an operator reading a blank card needs to know which one.
 */
export const VERDICTS = Object.freeze({
  /** A server named a model. Published verbatim. */
  NAMED: 'named',
  /** A server answered and lists nothing loaded. Publish nothing. */
  IDLE: 'idle',
  /** 401/403. Something is serving; we cannot name it. Publish nothing. */
  AUTH_BLOCKED: 'auth-blocked',
  /** Nothing listening. Publish nothing; the operator's setting may stand. */
  NO_SERVER: 'no-server',
  /** Probing is switched off for this box. */
  DISABLED: 'disabled',
});

/**
 * Split "host:port", "http://host:port", or "[::1]:8080" into its parts.
 * Returns null for anything unusable - a malformed endpoint disables the
 * probe rather than silently probing something else.
 */
export function parseEndpoint(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  text = text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!text) return null;

  let host;
  let portText;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    portText = bracketed[2];
  } else {
    const idx = text.lastIndexOf(':');
    // A bare IPv6 literal has several colons and no port. Treat it as a host.
    if (idx === -1 || text.indexOf(':') !== idx) {
      host = text;
    } else {
      host = text.slice(0, idx);
      portText = text.slice(idx + 1);
    }
  }
  if (!host) return null;
  const port = portText === undefined ? 80 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * The registry entry this machine's probe will use, or null when probing is
 * off.
 *
 * Built through `loadRegistry` rather than by hand, for one specific
 * property: that function REFUSES a credential written as a value. The
 * endpoint here comes from the environment, and an operator who pastes a
 * token into INTENT_MODEL_KEY_FILE instead of a path gets told so, by the
 * same check and in the same words as the shared registry file. A local
 * entry is not an excuse for a weaker rule about secrets.
 *
 * `allowLan` is on because this entry is explicitly the LOCAL box: 127.0.0.1
 * means "here" no matter which country the MacBook is in, which is the exact
 * opposite of the travelling-LAN-address problem the check guards against.
 *
 * @throws {RegistryError} on a token pasted where a path belongs
 */
export function servedModelEntry(env = process.env) {
  const raw = typeof env.INTENT_MODEL_ENDPOINT === 'string' ? env.INTENT_MODEL_ENDPOINT.trim() : '';
  if (DISABLED.has(raw.toLowerCase())) return null;

  const parsed = parseEndpoint(raw || DEFAULT_ENDPOINT);
  if (!parsed) return null;

  const kind = (typeof env.INTENT_MODEL_KIND === 'string' && env.INTENT_MODEL_KIND.trim()) || 'openai';
  const keyFile = typeof env.INTENT_MODEL_KEY_FILE === 'string' ? env.INTENT_MODEL_KEY_FILE.trim() : '';

  const [entry] = loadRegistry([{
    id: 'local',
    host: parsed.host,
    port: parsed.port,
    kind,
    ...(keyFile ? { auth: 'bearer', keyFile } : {}),
  }], { allowLan: true });
  return entry;
}

/**
 * Turn one probe result into the thing we publish, or nothing.
 *
 * The id is taken VERBATIM. It is the server's own name for what it loaded,
 * and prettifying it here is how a dashboard ends up showing a name that
 * matches no checkpoint anybody can find. `GLM-5.3-Flash-EXL3` is what asus1
 * calls it, so `GLM-5.3-Flash-EXL3` is what the card says.
 *
 * A server listing several models names the first: a heartbeat field is one
 * short string, and the alternative - joining them - produces a value that is
 * not any model's id.
 */
export function readVerdict(result) {
  if (result?.http === 'OK' && Array.isArray(result.models) && result.models.length) {
    const first = result.models.find(m => typeof m === 'string' && m.trim());
    if (first) {
      return { verdict: VERDICTS.NAMED, model: first.trim(), reachedServer: true, reason: null };
    }
  }
  if (result?.httpStatus === 401 || result?.httpStatus === 403) {
    // Something IS serving on that port - it bothered to reject us - but the
    // one thing we came for is the name, and we do not have it. Publishing
    // "unknown", "authenticated" or the last thing we saw would all be a
    // caption on a card that reads as fact. Nothing goes out, and the reason
    // says which repair to attempt.
    return { verdict: VERDICTS.AUTH_BLOCKED, model: undefined, reachedServer: true, reason: result.reason ?? null };
  }
  if (result?.http === 'DOWN') {
    // It answered and it is not serving a model. Live evidence, and it
    // outranks a configured name: the setting is provably stale.
    return { verdict: VERDICTS.IDLE, model: undefined, reachedServer: true, reason: result.reason ?? null };
  }
  return { verdict: VERDICTS.NO_SERVER, model: undefined, reachedServer: false, reason: result?.reason ?? null };
}

/**
 * A cached, self-expiring reading of what this box serves.
 *
 * `current()` is synchronous and never touches the network, so the heartbeat
 * can call it on every poll. `refresh()` is the only thing that does I/O, it
 * never throws, and nothing in the heartbeat path awaits it.
 */
export class ServedModelProbe {
  #entry;
  #fetchImpl;
  #env;
  #now;
  #timeoutMs;
  #intervalMs;
  #staleAfterMs;
  #timer = null;
  #last = null;
  #inFlight = null;

  /**
   * @param {object} [opts]
   * @param {object|null} [opts.entry] - loadRegistry entry; default from env
   * @param {number} [opts.intervalMs] - probe period (NOT the heartbeat's)
   * @param {number} [opts.staleAfterMs] - after this, a reading stops counting
   */
  constructor({
    entry,
    env = process.env,
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    intervalMs,
    staleAfterMs,
  } = {}) {
    this.#env = env;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;

    const fromEnv = Number(env?.INTENT_MODEL_PROBE_MS);
    this.#intervalMs = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PROBE_INTERVAL_MS);

    // Three missed probes, not one: a single timed-out fetch on a loaded box
    // should not blank a correct label. Three in a row is a pattern.
    this.#staleAfterMs = Number.isFinite(staleAfterMs) && staleAfterMs > 0
      ? staleAfterMs
      : this.#intervalMs * 3;

    this.#entry = entry !== undefined ? entry : this.#entryFromEnv();
  }

  #entryFromEnv() {
    try {
      return servedModelEntry(this.#env);
    } catch (err) {
      // A bad endpoint or a token pasted where a path belongs. Say so once,
      // then publish no model - never take the daemon down over a label.
      console.error(`served-model: probe disabled - ${err.message}`);
      return null;
    }
  }

  /** Is this probe configured to ask anything at all? */
  get enabled() {
    return this.#entry !== null && this.#entry !== undefined;
  }

  /** The endpoint being asked, for a log line. Never a credential. */
  describe() {
    if (!this.enabled) return 'disabled';
    return `${this.#entry.host}:${this.#entry.port} (${this.#entry.kind}${this.#entry.keyFile ? ', bearer' : ''})`;
  }

  /**
   * The last reading, IF it is still current. Expired readings report
   * `NO_SERVER` with no model rather than their old answer.
   */
  lastResult() {
    if (!this.enabled) {
      return { verdict: VERDICTS.DISABLED, model: undefined, reachedServer: false, reason: null };
    }
    if (!this.#last) {
      // Nothing measured yet. Not "no server" - we have not asked. Either way
      // there is no name to publish, and the first heartbeat goes out
      // immediately rather than waiting on a socket.
      return { verdict: VERDICTS.NO_SERVER, model: undefined, reachedServer: false, reason: 'not probed yet' };
    }
    if (this.#now() - this.#last.at > this.#staleAfterMs) {
      return {
        verdict: VERDICTS.NO_SERVER,
        model: undefined,
        reachedServer: false,
        reason: `last reading is older than ${this.#staleAfterMs} ms`,
      };
    }
    return this.#last.reading;
  }

  /** The model id to publish, or undefined. The heartbeat calls this. */
  current() {
    return this.lastResult().model;
  }

  /**
   * Ask the endpoint once. Never throws, never rejects: a probe that can take
   * down the caller is worse than no probe, because the caller is the thing
   * that reports the machine exists at all.
   */
  async refresh() {
    if (!this.enabled) return this.lastResult();
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = (async () => {
      let reading;
      try {
        const result = await probeServedModels(this.#entry, {
          fetchImpl: this.#fetchImpl,
          timeoutMs: this.#timeoutMs,
          now: this.#now,
          env: this.#env,
        });
        reading = readVerdict(result);
      } catch (err) {
        // Includes a thrown fetch, a rejected AbortSignal, and any bug above.
        // It is an absent reading, never a retained one.
        reading = {
          verdict: VERDICTS.NO_SERVER,
          model: undefined,
          reachedServer: false,
          reason: `probe error: ${err?.message ?? err}`,
        };
      }
      this.#last = { reading, at: this.#now() };
      return reading;
    })().finally(() => { this.#inFlight = null; });

    return this.#inFlight;
  }

  /** Probe now, then on the probe's own interval. Unref'd: never holds the
   * process open, because a label is not a reason to stay alive. */
  start() {
    this.stop();
    if (!this.enabled) return;
    this.refresh().catch(() => {});
    this.#timer = setInterval(() => { this.refresh().catch(() => {}); }, this.#intervalMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

export { DEFAULT_TIMEOUT_MS };
