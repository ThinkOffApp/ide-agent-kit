# Remaining execSync (second change)

Branch `fix/aikido-exec-no-shell` through 5dedac2 already covers what room text can reach: automation exec, the tmux nudge helper, and poller HTTP (Node fetch, token in a header). This file is the handover list; do not treat a later docs commit as a code change.

Do not convert the sites below on this branch. Each line is an `execSync` still present after 5dedac2, with the interpolated values and where they come from.

## src/common/check.mjs

- L46 `execSync(cmd)` — `cmd` is one of the fixed strings `node --version`, `tmux -V`, `claude-mem --version`.
- L68 `execSync(cmd)` — same fixed `claude-mem --version` for the optional memory backend check.

## bin/cli.mjs

- L1552 `execSync('claude-mem --version')` — fixed string, init-time capability probe.

## src/utils.mjs

- L12 `nudgeCommand`: `execSync(command)` — whole `command` string from `poller.nudge_command` (config). `text` and `session` go in env as `IAK_NUDGE_TEXT` / `IAK_TMUX_SESSION`, not into the command string.

## src/room-poller.mjs

- L180 heartbeat: `execSync(\`tmux send-keys -t ${JSON.stringify(session)} Escape\`)` — `session` from `sessionOpt` or `config.tmux.ide_session` / `default_session`. Only when `nudge_mode === 'tmux'`. (The team-relay copy of this poller no longer has this call.)

## src/session-keepalive.mjs

- L99 `execSync(\`rm -f ${pidFile}\`)` — `pidFile` from `options.pidFile` or `config.keepalive.pidFile` or a module default.
- L112 `execSync("ps -eo pid,args | grep 'caffeinate' | grep -v grep")` — fixed string.
- L139 `execSync('pmset -g custom 2>/dev/null')` — fixed string.

## src/mcp-server.mjs

- L72 `listTmuxSessions`: `execSync(\`tmux list-sessions -F '...'\`)` — format string is fixed.
- L364 `captureTmuxPane`: `execSync(\`tmux capture-pane -p -t ${JSON.stringify(session)} -S -${safeLines}\`)` — `session` from MCP tool args; `safeLines` is a clamped integer from args.

## src/tmux-runner.mjs (copy: src/ide/tmux-runner.mjs)

Both files are full copies, not re-exports.

- L9 `tmux has-session -t ${JSON.stringify(session)}` — `session` from caller / `config.tmux.default_session`.
- L16 `tmux new-session -d -s ${JSON.stringify(session)}` — same session.
- L62 `tmux send-keys -t ${JSON.stringify(sessionName)} ${JSON.stringify(wrappedCmd)} C-m` — `wrappedCmd` interpolates `cwd` (caller) and `cmd` (caller, after `config.tmux.allow` prefix match).
- L86 `cat ${exitFile}` — path `/tmp/iak-exit-${traceId.slice(0,8)}`; `traceId` is `randomUUID()`.
- L104 `tail -${tailLines} ${outFile}` — `tailLines` from `config.receipts.stdout_tail_lines`; path from `traceId`.
- L105 same for `errFile`.
- L108 `rm -f ${outFile} ${errFile} ${exitFile}` — same temp paths.

## src/team-relay/webhook-server.mjs

- L342 `execSync(wakeCmd)` — whole command from `config.poller.nudge_command` or `config.poller.wake_script`. `src/webhook-server.mjs` no longer has this call.

## src/discord-poller.mjs (copy: src/team-relay/discord-poller.mjs)

- L65 `execSync(cmd)` — `cmd` is `export PATH=... && export OPENCLAW_HOME=${oc.home} && ${oc.bin} message read --channel discord --target ${channelId} --limit ${limit} --json`, optionally wrapped in `ssh ${oc.ssh} '...'`.
  - `oc.home` / `oc.bin` / `oc.ssh` from `config.openclaw` (else module defaults / env).
  - `channelId` from Discord poller config.
  - `limit` is the function argument (default 20).

## src/memory.mjs (copy: src/team-relay/memory.mjs)

- L146 `execSync(cmd)` — OpenClaw `memory search '${safeQuery}' --limit ${maxResults} --json`, same `oc.home`/`bin`/`ssh` wrapping as discord-poller.
  - `query` from the caller (MCP / CLI); single quotes escaped.
  - `maxResults` from caller options (default 10).

## src/openclaw-gateway.mjs

Shared `ocExec` (L34): `OPENCLAW_HOME=${oc.home}` plus `${oc.bin} ${subcommand}`, optional `ssh ${oc.ssh}`. `home`/`bin`/`ssh` from `config.openclaw` or options or env. `subcommand` is a fixed string or built by the exported function.

- L41 `ocExec` used by agents list and other CLI wrappers — subcommand from caller.
- L105 `configGet`: `cat ${oc.home}/openclaw.json` (or ssh+cat).
- L129 `configPatch`: `echo '${safeJson}' > ${oc.home}/openclaw.json` — `safeJson` is the merged config with single quotes escaped.
- L159 `gatewayRestart`: `nohup ${oc.bin} gateway --force > /tmp/gw_restart.log 2>&1 &`.

## src/openclaw-sessions.mjs

- L38 `ocExec` — same wrapper as gateway. Subcommands interpolate `params.message` / `params.task` (single-quote escaped), `params.agentId`, `params.model`.
- L101 `execSync(readCmd)` — `ls -t ${dataDir}/agents/${agentId}/sessions/*.jsonl | head -1 | xargs tail -${limit}`.
  - `dataDir` derived from `oc.home`.
  - `agentId` from `params.sessionKey` (second colon-separated field, default `main`).
  - `limit` from `params.limit` (default 20).

## src/openclaw-cron.mjs

- L37 `ocExec` — same `home`/`bin`/`ssh` wrapper; `subcommand` from the cron helper (list/add/remove).

## packages/user-intent-kit (outside src/, listed for completeness)

- `bin/uik-daemon.js` L169 `execSync(gateCmd)` — whole command from env `INTENT_AGENT_GATE_CMD`.
- `src/adapters/desktop.js` L240 `execSync(\`osascript -e 'tell application "System Events" ...'\`)` — AppleScript string is fixed.

## Not in this list

`execFileSync` leftovers (argv, no shell) are out of scope for the next execSync pass: `src/common/notify.mjs` tmux nudge, `src/room-automation.mjs` exec action, `src/adapters/discord.mjs` OpenClaw, `src/history-scan.mjs` git, `scripts/check-stageable-secrets.mjs` git, `bin/model-tidy.mjs` curl POST to GroupMind.

Room HTTP on this branch already uses `src/common/http.mjs` `fetchJson` (or direct `fetch` in `src/room-automation.mjs`).
