// SPDX-License-Identifier: AGPL-3.0

/**
 * IntentClient - REST client for the User Intent API.
 * Talks to an Ant Farm instance hosting profile + intent endpoints.
 */
export class IntentClient {
  #baseUrl;
  #apiKey;
  #userId;
  #deviceId;
  #heartbeatTimer;
  #heartbeatIntervalMs;
  #timeoutMs;

  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Ant Farm API base URL (e.g. "https://antfarm.world/api/v1")
   * @param {string} opts.apiKey - X-API-Key for authentication
   * @param {string} opts.userId - User ID to read/write intent for
   * @param {string} [opts.deviceId] - Device slot this client writes to (omit for read-only)
   * @param {number} [opts.heartbeatIntervalMs=30000] - Heartbeat interval in ms
   * @param {number} [opts.timeoutMs=10000] - Request timeout in ms
   */
  constructor({ baseUrl, apiKey, userId, deviceId, heartbeatIntervalMs = 30000, timeoutMs = 10000 }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#userId = userId;
    this.#deviceId = deviceId || null;
    this.#heartbeatIntervalMs = Math.max(heartbeatIntervalMs, 10000);
    this.#timeoutMs = timeoutMs;
    this.#heartbeatTimer = null;
  }

  // --- Profile (static layer) ---

  async getProfile() {
    return this.#request('GET', `/profile/${this.#userId}`);
  }

  async updateProfile(fields) {
    return this.#request('PUT', `/profile/${this.#userId}`, fields);
  }

  // --- Intent (live layer) ---

  async getIntent() {
    return this.#request('GET', `/intent/${this.#userId}`);
  }

  async patchDevice(fields) {
    if (!this.#deviceId) throw new Error('No deviceId configured');
    return this.#request('PATCH', `/intent/${this.#userId}/${this.#deviceId}`, fields);
  }

  async setDevice(fields) {
    if (!this.#deviceId) throw new Error('No deviceId configured');
    return this.#request('PUT', `/intent/${this.#userId}/${this.#deviceId}`, fields);
  }

  async removeDevice(deviceId) {
    const id = deviceId || this.#deviceId;
    if (!id) throw new Error('No deviceId specified');
    return this.#request('DELETE', `/intent/${this.#userId}/${id}`);
  }

  async patchAgent(agentName, fields) {
    return this.#request('PATCH', `/intent/${this.#userId}/agents/${agentName}`, fields);
  }

  // --- Derived state helpers ---

  async getDerived() {
    const intent = await this.getIntent();
    return intent.derived || {};
  }

  async isInMeeting() {
    const derived = await this.getDerived();
    return derived.urgency_mode === 'text-only' || false;
  }

  async preferredModality() {
    const derived = await this.getDerived();
    return derived.available_modalities || ['read', 'listen', 'speak'];
  }

  async shouldSuppressAudio() {
    const derived = await this.getDerived();
    return derived.suppress_audio || false;
  }

  async preferredDevice() {
    const derived = await this.getDerived();
    return derived.preferred_device || null;
  }

  // --- 2-Level State Model ---

  /**
   * Overall life state of the user.
   * @returns {Promise<string>} One of: working, resting, meeting_people, outdoors, exercising, sleeping, unknown, transitioning
   */
  async overallState() {
    const derived = await this.getDerived();
    return derived.overall_state || 'unknown';
  }

  /**
   * Per-state reachability mode (how accessible the user is within their current state).
   * @returns {Promise<string>} State-specific reachability like desktop, mobile_full_focus, watch_only, emergency_only, etc.
   */
  async reachabilityMode() {
    const derived = await this.getDerived();
    return derived.reachability_mode || 'unknown';
  }

  /**
   * Whether background/dreaming work is appropriate right now.
   * True when user is away, sleeping, or idle. False during active focus sessions.
   * @returns {Promise<boolean>}
   */
  async isDreamingAllowed() {
    const derived = await this.getDerived();
    const state = derived.overall_state || 'unknown';
    const urgency = derived.urgency_mode || 'normal';
    // Dreaming allowed when user is sleeping, resting, or away
    const dreamStates = ['sleeping', 'resting', 'unknown'];
    if (dreamStates.includes(state)) return true;
    // Also allowed if urgency is not emergency-only and not in active focus
    if (urgency === 'emergency-only') return false;
    if (state === 'working') {
      const reachability = derived.reachability_mode || 'unknown';
      // Only light phase during active work sessions
      return reachability !== 'desktop' && reachability !== 'mobile_full_focus';
    }
    return true;
  }

  /**
   * Whether only light-phase dreaming should run (vs full deep consolidation).
   * True during softer active sessions where full dreaming would be disruptive.
   * @returns {Promise<boolean>}
   */
  async isLightDreamingOnly() {
    const derived = await this.getDerived();
    const state = derived.overall_state || 'unknown';
    if (state === 'working') return true;
    if (state === 'meeting_people') return true;
    if (state === 'outdoors') return true;
    if (state === 'exercising') return true;
    return false;
  }

  // --- Heartbeat ---

  async heartbeat() {
    if (!this.#deviceId) throw new Error('No deviceId configured');
    return this.#request('PATCH', `/intent/${this.#userId}/${this.#deviceId}`, { heartbeat: true });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, this.#heartbeatIntervalMs);
    // Don't keep process alive just for heartbeats
    if (this.#heartbeatTimer.unref) this.#heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  // --- Internal ---

  async #request(method, path, body) {
    const url = `${this.#baseUrl}${path}`;
    const headers = {
      'X-API-Key': this.#apiKey,
      'Content-Type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    const opts = { method, headers, signal: controller.signal };
    if (body && method !== 'GET' && method !== 'DELETE') {
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Intent API ${method} ${path}: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  get userId() { return this.#userId; }
  get deviceId() { return this.#deviceId; }
}
