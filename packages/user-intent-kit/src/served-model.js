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
 * WHAT A LISTING IS WORTH, WHICH IS LESS THAN THIS FILE ONCE ASSUMED
 *
 * The first version of this reporter treated "a server listed it" as "a
 * server loaded it". Measured in production 20 Sep 2026, that is false:
 * `mlx_lm server` enumerates the local HuggingFace cache, so a 75 GiB model
 * that was still downloading appeared in `/v1/models` on a box serving a
 * 2.3 GiB one, and the dashboard announced the MacBook was serving it. It
 * could not even have loaded it - a generation request answered `Model type
 * qwen4_exp not supported`.
 *
 * So the ranking is now: a model that GENERATED a token beats everything,
 * because that is the only evidence that anything is actually loaded. A
 * listing is evidence that files exist on a disk, which is the same grade of
 * evidence as a directory scan, and it is labelled LISTED and published as
 * such. "We asked and got no name" beats a configured name - it publishes
 * nothing.
 *
 * The generation probe is OFF by default. It costs a forward pass on
 * somebody's machine and, against a server that loads on demand, it can cause
 * a load. The consequence is deliberate and worth stating plainly: with it
 * off, no box publishes a served `model` at all. An unproven claim is not a
 * cheaper version of a proven one, and a blank field is the honest rendering
 * of "nobody asked".
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

import { loadRegistry, probeServedModels, probeGeneration, DEFAULT_TIMEOUT_MS } from './model-capacity.js';

/** Where a local model server listens when nobody says otherwise. */
export const DEFAULT_ENDPOINT = '127.0.0.1:8080';

/** The probe's own interval: slower than the heartbeat, on purpose. */
export const DEFAULT_PROBE_INTERVAL_MS = 300000;

/** One socket's worth of patience. Loopback; a slow answer is a broken one. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000;

/** Values of INTENT_MODEL_ENDPOINT that mean "do not probe at all". */
const DISABLED = new Set(['0', 'off', 'none', 'no', 'disabled', 'false']);

/** Values of INTENT_MODEL_GENERATE that switch the generation probe ON. */
const ENABLED = new Set(['1', 'on', 'yes', 'true', 'enabled']);

/**
 * The shortest gap between two generation probes.
 *
 * A model swap is a human-scale event; five minutes of resolution is plenty,
 * and the probe costs somebody else's compute. This is a floor enforced by the
 * probe itself, not a suggestion to the caller.
 */
export const DEFAULT_GENERATION_MIN_MS = 300000;

/** One generation's worth of patience. A loaded model answers in well under this. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 5000;

/** Hosts a generation probe may talk to without an explicit endpoint setting. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Why we are publishing what we are publishing. Exported because the daemon
 * logs it and the tests assert on it: "no model" has four different causes
 * and an operator reading a blank card needs to know which one.
 */
export const VERDICTS = Object.freeze({
  /**
   * A model GENERATED a token when asked. The only proof that it is loaded,
   * and the only verdict that publishes a name as served.
   */
  GENERATED: 'generated',
  /**
   * A server's `/v1/models` names it, and that is the whole of the evidence.
   *
   * It used to be called NAMED and it used to mean served. It does not.
   * Measured in production 20 Sep 2026: `mlx_lm server` enumerates the local
   * HuggingFace cache, so a 75 GiB model that was still downloading - and
   * that the build could not load at all, `Model type qwen4_exp not
   * supported` - was listed by a server holding a 2.3 GiB one. A listing
   * proves some files exist on disk. That is the same grade of evidence as a
   * directory scan, so it is labelled like one and it publishes no served
   * name.
   */
  LISTED: 'listed',
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
 * Turn one listing into a verdict. Never into a served name.
 *
 * Ids are taken VERBATIM. They are the server's own names, and prettifying
 * them here is how a dashboard ends up showing a name that matches no
 * checkpoint anybody can find. `GLM-5.3-Flash-EXL3` is what asus1 calls it,
 * so `GLM-5.3-Flash-EXL3` is what the card says.
 *
 * ALL the listed ids come back, as an array. The old version named the first
 * one, which is a coin toss dressed as a reading: a server listing several
 * models cannot have them all resident, so the first is not "the" model any
 * more than the third is. Joining them with commas is worse - it produces a
 * string that is not any model's id, and that string is what reached the
 * dashboard. The caller decides what a multi-model listing means; this
 * function refuses to pick.
 */
export function readVerdict(result) {
  if (result?.http === 'OK' && Array.isArray(result.models) && result.models.length) {
    const listed = result.models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim());
    if (listed.length) {
      // No `model`. A listing is not a loading, and the field that means
      // "this box is serving X" stays empty until something generates.
      return { verdict: VERDICTS.LISTED, model: undefined, listed, reachedServer: true, reason: null };
    }
  }
  if (result?.httpStatus === 401 || result?.httpStatus === 403) {
    // Something IS serving on that port - it bothered to reject us - but the
    // one thing we came for is the name, and we do not have it. Publishing
    // "unknown", "authenticated" or the last thing we saw would all be a
    // caption on a card that reads as fact. Nothing goes out, and the reason
    // says which repair to attempt.
    return { verdict: VERDICTS.AUTH_BLOCKED, model: undefined, listed: [], reachedServer: true, reason: result.reason ?? null };
  }
  if (result?.http === 'DOWN') {
    // It answered and it is not serving a model. Live evidence, and it
    // outranks a configured name: the setting is provably stale.
    return { verdict: VERDICTS.IDLE, model: undefined, listed: [], reachedServer: true, reason: result.reason ?? null };
  }
  return { verdict: VERDICTS.NO_SERVER, model: undefined, listed: [], reachedServer: false, reason: result?.reason ?? null };
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
  #generate;
  #generateMinMs;
  #generateTimeoutMs;
  #guard;
  #lastGenerationAt = null;
  #endpointExplicit;

  /**
   * @param {object} [opts]
   * @param {object|null} [opts.entry] - loadRegistry entry; default from env
   * @param {number} [opts.intervalMs] - probe period (NOT the heartbeat's)
   * @param {number} [opts.staleAfterMs] - after this, a reading stops counting
   * @param {boolean} [opts.generate] - ask one token to prove it is loaded.
   *   OFF unless INTENT_MODEL_GENERATE says otherwise: it spends compute on
   *   somebody else's box, and a box that has not loaded the model may try to.
   * @param {(id: string) => boolean|Promise<boolean>} [opts.guard] - veto on a
   *   candidate before any generation request is sent. The daemon wires this
   *   to the disk scan so an incomplete or oversized model is never asked.
   */
  constructor({
    entry,
    env = process.env,
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    intervalMs,
    staleAfterMs,
    generate,
    generateMinMs,
    generateTimeoutMs,
    guard,
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

    // OFF by default, and it takes an explicit word to turn on. The cost is
    // real - one forward pass, and possibly a model load - and it is charged
    // to whoever runs the daemon, not to whoever reads the dashboard.
    const wanted = String(env?.INTENT_MODEL_GENERATE ?? '').trim().toLowerCase();
    this.#generate = typeof generate === 'boolean' ? generate : ENABLED.has(wanted);

    const minFromEnv = Number(env?.INTENT_MODEL_GENERATE_MIN_MS);
    this.#generateMinMs = Number.isFinite(generateMinMs) && generateMinMs >= 0
      ? generateMinMs
      : (Number.isFinite(minFromEnv) && minFromEnv >= 0 ? minFromEnv : DEFAULT_GENERATION_MIN_MS);

    this.#generateTimeoutMs = Number.isFinite(generateTimeoutMs) && generateTimeoutMs > 0
      ? generateTimeoutMs
      : DEFAULT_GENERATION_TIMEOUT_MS;

    this.#guard = typeof guard === 'function' ? guard : null;
    this.#endpointExplicit = typeof env?.INTENT_MODEL_ENDPOINT === 'string'
      && env.INTENT_MODEL_ENDPOINT.trim() !== '';
  }

  /**
   * May we spend a token on this endpoint at all?
   *
   * Two separate refusals. A generation probe is never sent to a host the
   * operator did not name: the default endpoint is a convenience for reading a
   * listing on loopback, and silently turning it into "POST a prompt to
   * whatever is on 8080 of some other machine" is not a convenience. And it is
   * never sent more often than the floor, because a model swap is a
   * human-scale event and this costs a forward pass.
   */
  #mayGenerate() {
    if (!this.#generate || !this.enabled) return false;
    const host = String(this.#entry.host).toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(host) && !this.#endpointExplicit) return false;
    if (this.#lastGenerationAt === null) return true;
    return this.#now() - this.#lastGenerationAt >= this.#generateMinMs;
  }

  /**
   * Which single id, if any, it is honest to ask about.
   *
   * A server listing several models cannot have them all resident, and naming
   * one of them in a generation request is not a read - on a server that loads
   * on demand it is an instruction to load that model. So a multi-model
   * listing produces no candidate at all and stays LISTED. The old code picked
   * the first id; picking is exactly what must not happen here.
   */
  #candidate(listed) {
    return Array.isArray(listed) && listed.length === 1 ? listed[0] : null;
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
      return { verdict: VERDICTS.DISABLED, model: undefined, listed: [], reachedServer: false, reason: null };
    }
    if (!this.#last) {
      // Nothing measured yet. Not "no server" - we have not asked. Either way
      // there is no name to publish, and the first heartbeat goes out
      // immediately rather than waiting on a socket.
      return { verdict: VERDICTS.NO_SERVER, model: undefined, listed: [], reachedServer: false, reason: 'not probed yet' };
    }
    if (this.#now() - this.#last.at > this.#staleAfterMs) {
      return {
        verdict: VERDICTS.NO_SERVER,
        model: undefined,
        listed: [],
        reachedServer: false,
        reason: `last reading is older than ${this.#staleAfterMs} ms`,
      };
    }
    return this.#last.reading;
  }

  /**
   * The model id to publish as SERVED, or undefined. The heartbeat calls this.
   *
   * Only a GENERATED verdict fills it. With the generation probe off - which
   * is the default - this returns undefined on every box, and that is the
   * intended reading: without a token we do not know that anything is loaded,
   * and the field means loaded. What a server merely lists travels in
   * `listed()` instead, clearly labelled as the weaker claim it is.
   */
  current() {
    const seen = this.lastResult();
    return seen.verdict === VERDICTS.GENERATED ? seen.model : undefined;
  }

  /** Every id the endpoint advertises. Files on a disk somewhere, no more. */
  listed() {
    return this.lastResult().listed ?? [];
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
        reading = await this.#proveIfAllowed(reading);
      } catch (err) {
        // Includes a thrown fetch, a rejected AbortSignal, and any bug above.
        // It is an absent reading, never a retained one.
        reading = {
          verdict: VERDICTS.NO_SERVER,
          model: undefined,
          listed: [],
          reachedServer: false,
          reason: `probe error: ${err?.message ?? err}`,
        };
      }
      this.#last = { reading, at: this.#now() };
      return reading;
    })().finally(() => { this.#inFlight = null; });

    return this.#inFlight;
  }

  /**
   * Try to upgrade a LISTED reading to GENERATED, or leave it exactly as it is.
   *
   * Every exit from here that is not a returned token leaves the verdict at
   * LISTED. A refused guard, a rate limit, a timeout, an HTTP error, an
   * unloadable architecture: all of them are things we could not prove, and
   * none of them is a reason to claim more than the listing already did.
   */
  async #proveIfAllowed(reading) {
    if (reading.verdict !== VERDICTS.LISTED) return reading;

    const candidate = this.#candidate(reading.listed);
    if (!candidate) {
      return { ...reading, reason: `${reading.listed.length} models listed; none can be shown to be the loaded one` };
    }
    if (!this.#mayGenerate()) return reading;

    if (this.#guard) {
      let allowed = false;
      try {
        allowed = await this.#guard(candidate);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return { ...reading, reason: 'not asked to generate: the bytes on disk do not support it' };
      }
    }

    this.#lastGenerationAt = this.#now();
    const proof = await probeGeneration(this.#entry, {
      modelId: candidate,
      fetchImpl: this.#fetchImpl,
      timeoutMs: this.#generateTimeoutMs,
      now: this.#now,
      env: this.#env,
    });

    if (!proof.generated) return { ...reading, reason: proof.reason };
    return { ...reading, verdict: VERDICTS.GENERATED, model: proof.model, reason: null };
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
