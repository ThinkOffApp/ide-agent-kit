import { execSync } from 'node:child_process';

export { nudgeTmux } from './common/notify.mjs';

/**
 * Run an arbitrary command as a nudge bridge (for non-tmux IDEs, e.g. GUI apps).
 * Command runs with IAK_NUDGE_TEXT and IAK_TMUX_SESSION in env.
 */
export function nudgeCommand(command, { text = 'check rooms', session = '' } = {}) {
  if (!command || typeof command !== 'string') return false;
  try {
    execSync(command, {
      stdio: 'ignore',
      env: {
        ...process.env,
        IAK_NUDGE_TEXT: text,
        IAK_TMUX_SESSION: session
      }
    });
    return true;
  } catch {
    return false;
  }
}
