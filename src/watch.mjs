import { watch, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Watch the queue JSONL file for new entries and trigger tmux nudge immediately.
 * This replaces slow polling with instant file-change detection.
 */
export function watchQueue(config, onNewEvent) {
  const queuePath = config.queue.path;
  const session = config.tmux?.ide_session || 'claude';
  const nudgeText = config.tmux?.nudge_text || 'check rooms';
  let lastSize = 0;

  try {
    lastSize = statSync(queuePath).size;
  } catch { /* file may not exist yet */ }

  console.log(`Watching ${queuePath} for new events...`);
  console.log(`  tmux nudge → session "${session}" with "${nudgeText}"`);

  // Use fs.watchFile for reliable cross-platform polling (works on all FS types)
  const watcher = watch(queuePath, { persistent: true }, (eventType) => {
    if (eventType !== 'change') return;

    let currentSize;
    try {
      currentSize = statSync(queuePath).size;
    } catch { return; }

    if (currentSize <= lastSize) {
      lastSize = currentSize;
      return;
    }

    // Read only the new bytes
    const fd = readFileSync(queuePath, 'utf8');
    const allLines = fd.trim().split('\n');

    // Figure out new lines by counting from old size
    const oldContent = fd.slice(0, lastSize);
    const oldLineCount = oldContent ? oldContent.trim().split('\n').length : 0;
    const newLines = allLines.slice(oldLineCount);
    lastSize = currentSize;

    if (newLines.length === 0) return;

    const events = [];
    for (const line of newLines) {
      try {
        events.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }

    if (events.length === 0) return;

    console.log(`[${new Date().toISOString()}] ${events.length} new event(s) in queue`);

    // Trigger callback for each event
    for (const event of events) {
      if (onNewEvent) onNewEvent(event);
    }

    // Nudge tmux session
    nudgeTmux(session, nudgeText);
  });

  return watcher;
}

function nudgeTmux(session, text) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`);
  } catch {
    console.log(`  tmux session "${session}" not found, skipping nudge`);
    return;
  }

  try {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} -l ${JSON.stringify(text)}`);
    // Small delay then Enter
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`);
      } catch {}
    }, 300);
    console.log(`  nudged tmux session "${session}"`);
  } catch (e) {
    console.log(`  tmux nudge failed: ${e.message}`);
  }
}
