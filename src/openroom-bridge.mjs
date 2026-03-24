/**
 * OpenRoom Bridge for IDE Agent Kit
 *
 * Connects OpenClaw agents to MiniMax OpenRoom (browser-based AI desktop).
 * Agents can send actions to OpenRoom apps (Music, Chess, Email, etc.)
 * and receive lifecycle events back through GroupMind rooms.
 *
 * Protocol: OpenRoom uses CharacterAppAction for bidirectional communication.
 * This bridge translates between room messages and OpenRoom actions.
 *
 * @see https://github.com/MiniMax-AI/OpenRoom
 */

import { EventEmitter } from 'node:events';

// OpenRoom action trigger sources
const TRIGGER_BY = { User: 1, Agent: 2, System: 3 };

// Known OpenRoom app IDs (from their built-in apps)
const APP_IDS = {
  music: 1,
  chess: 2,
  gomoku: 3,
  freecell: 4,
  email: 5,
  diary: 6,
  twitter: 7,
  album: 8,
  cybernews: 9,
};

/**
 * OpenRoom Bridge
 *
 * Usage:
 *   const bridge = new OpenRoomBridge({ openroomUrl: 'http://localhost:3000', roomApi, roomSlug });
 *   bridge.start();
 *
 * Room messages like "@openroom play jazz" get translated to OpenRoom actions.
 * OpenRoom lifecycle events get posted back to the room.
 */
export class OpenRoomBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this.openroomUrl = config.openroomUrl || 'http://localhost:3000';
    this.wsUrl = config.wsUrl || this.openroomUrl.replace(/^http/, 'ws') + '/ws';
    this.roomApi = config.roomApi; // { baseUrl, apiKey, room }
    this.pollInterval = config.pollInterval || 5000;
    this.ws = null;
    this.connected = false;
    this.actionCounter = 0;
  }

  /**
   * Send an action to OpenRoom
   * @param {string} appName - App name (music, chess, email, etc.)
   * @param {string} actionType - Action type (e.g. PLAY_TRACK, CREATE_POST)
   * @param {Record<string, string>} params - Action parameters
   */
  async sendAction(appName, actionType, params = {}) {
    const appId = APP_IDS[appName.toLowerCase()];
    if (!appId) {
      throw new Error(`Unknown OpenRoom app: ${appName}. Known: ${Object.keys(APP_IDS).join(', ')}`);
    }

    const action = {
      app_id: appId,
      action_id: ++this.actionCounter,
      action_type: actionType,
      params,
      timestamp_ms: Date.now(),
      trigger_by: TRIGGER_BY.Agent,
    };

    // Send via WebSocket if connected
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({
        type: 'agent_action',
        action,
      }));
      this.emit('action_sent', action);
      return action;
    }

    // Fallback: send via HTTP API if available
    try {
      const resp = await fetch(`${this.openroomUrl}/api/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      if (resp.ok) {
        this.emit('action_sent', action);
        return action;
      }
    } catch (e) {
      // HTTP fallback failed
    }

    throw new Error('Not connected to OpenRoom');
  }

  /**
   * Parse a room message into an OpenRoom action
   * Messages like "@openroom music play jazz" or "@openroom email compose to:bob subject:hello"
   */
  parseRoomMessage(body) {
    const match = body.match(/@openroom\s+(\w+)\s+(\w+)\s*(.*)/i);
    if (!match) return null;

    const [, appName, actionType, paramStr] = match;
    const params = {};

    // Parse key:value params or treat remainder as a single "query" param
    if (paramStr.includes(':')) {
      paramStr.split(/\s+/).forEach(kv => {
        const [k, ...v] = kv.split(':');
        if (k && v.length) params[k] = v.join(':');
      });
    } else if (paramStr.trim()) {
      params.query = paramStr.trim();
    }

    return { appName, actionType: actionType.toUpperCase(), params };
  }

  /**
   * Post an OpenRoom event back to the GroupMind room
   */
  async postToRoom(message) {
    if (!this.roomApi) return;
    try {
      await fetch(`${this.roomApi.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.roomApi.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          room: this.roomApi.room,
          body: message,
        }),
      });
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * Handle incoming room messages and translate to OpenRoom actions
   */
  async handleRoomMessage(msg) {
    const parsed = this.parseRoomMessage(msg.body || '');
    if (!parsed) return;

    try {
      const action = await this.sendAction(parsed.appName, parsed.actionType, parsed.params);
      this.emit('action_executed', { msg, action });
    } catch (e) {
      await this.postToRoom(`[OpenRoom] Failed to execute: ${e.message}`);
    }
  }

  /**
   * Connect to OpenRoom WebSocket for real-time events
   */
  async connect() {
    try {
      const WebSocket = (await import('ws')).default;
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.emit('connected');
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this.emit('openroom_event', event);

          // Forward lifecycle events to room
          if (event.type === 'app_lifecycle' && this.roomApi) {
            this.postToRoom(`[OpenRoom] ${event.app || 'App'}: ${event.status || event.type}`);
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reconnect after 5s
        setTimeout(() => this.connect(), 5000);
      });

      this.ws.on('error', (e) => {
        this.emit('error', e);
      });
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * Start the bridge (connect to OpenRoom + listen for room messages)
   */
  async start() {
    await this.connect();
    this.emit('started');
  }

  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.emit('stopped');
  }
}

export default OpenRoomBridge;
