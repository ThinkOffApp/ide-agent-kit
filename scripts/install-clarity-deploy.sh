#!/usr/bin/env bash
# install-clarity-deploy.sh
#
# OPTION 1 installer (prepared by ClaudeMB, RUN BY PETRUS) for button-gated
# Clarity deploys. ClaudeMB is NOT allowed to install its own deploy executor
# (self-grant), so a human runs this. It:
#   1. reconciles the daemon branch (room_react + MacBook mods + main's /actions)
#   2. adds the clarity -> clarity_build deploy executor (executeDeploySite)
#   3. syntax-checks
#   4. commits on the branch
# It does NOT restart the daemon and does NOT deploy. The daemon is a child of
# your Antigravity IDE, so YOU restart it after this (see printed steps), and the
# first real deploy only happens when you tap Approve on a CodeWatch button.
#
# Reviewed design: ether (thinkoff-development, 2026-06-23). Rollback backup of
# the live daemon files is in /tmp/iak-backup.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
BRANCH="feat/daemon-actions-room-react"
echo "[1/6] repo: $REPO_DIR  branch target: $BRANCH"

git checkout "$BRANCH"
git fetch origin main

echo "[2/6] merge origin/main (bring in /actions), keep our clarity allowlist"
git merge origin/main --no-commit --no-ff || true
# only expected conflict is the clarity allowlist in action-request.mjs -> keep ours
if git ls-files -u | grep -q 'scripts/action-request.mjs'; then
  git checkout --ours scripts/action-request.mjs
  git add scripts/action-request.mjs
fi
# fail loudly if any OTHER conflict remains
if git ls-files -u | grep -q .; then
  echo "ERROR: unexpected merge conflicts remain:"; git ls-files -u | awk '{print $4}' | sort -u
  echo "Resolve manually or run: git merge --abort"; exit 1
fi

echo "[3/6] patch src/confirmations.mjs (allow clarity + wire + add executeDeploySite)"
node - <<'PATCH'
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'src/confirmations.mjs';
let s = readFileSync(f, 'utf8');

// 3a. allow the clarity project in deploy_site validation
const allowFrom = "if (!['codewatch-web', 'groupmind'].includes(project)) throw new Error(`project not allowed: ${project}`);";
const allowTo   = "if (!['codewatch-web', 'groupmind', 'clarity'].includes(project)) throw new Error(`project not allowed: ${project}`);";
if (s.includes(allowFrom)) s = s.replace(allowFrom, allowTo);
else if (!s.includes(allowTo)) throw new Error('could not find deploy_site project allowlist');

// 3b. wire deploy_site -> executeDeploySite in runApprovedAction
const wireFrom = "    case 'merge_pr':\n      await executeMergePr(action, { receiptsPath });\n      break;";
const wireTo = wireFrom + "\n    case 'deploy_site':\n      await executeDeploySite(action, { receiptsPath });\n      break;";
if (!s.includes("await executeDeploySite(action")) {
  if (!s.includes(wireFrom)) throw new Error('could not find merge_pr case to wire deploy_site');
  s = s.replace(wireFrom, wireTo);
}

// 3c. append the MacBook-only executor (clarity -> Vercel project clarity_build)
if (!s.includes('async function executeDeploySite')) {
  s += `

// MacBook-only deploy executor. Vercel auth + the clarity_build project link live
// on this machine. Clones the repo into an IAK cache and deploys main to prod.
async function executeDeploySite(action, { receiptsPath } = {}) {
  const MAP = { clarity: { repo: 'ThinkOffApp/clarity', vercelProject: 'clarity_build', scope: 'thinkoffapps-projects' } };
  const cfg = MAP[action.target.project];
  if (!cfg) {
    settleAction(action, { status: 'failed', actor: 'petrus', decided_at: action.decided_at, ran_at: action.ran_at, command: null, exit_code: null, output_summary: \`No deploy executor for \${action.target.project}\` }, { receiptsPath });
    return;
  }
  const dir = \`\${process.env.HOME}/.iak-deploy-cache/\${action.target.project}\`;
  const prepCmd = ['bash', '-lc', \`set -e; mkdir -p '\${dir}'; if [ -d '\${dir}/.git' ]; then git -C '\${dir}' fetch origin main && git -C '\${dir}' reset --hard origin/main; else gh repo clone \${cfg.repo} '\${dir}'; fi\`];
  action.command = shellSummary(prepCmd);
  const prep = await spawnCollect(prepCmd[0], prepCmd.slice(1));
  if (prep.code !== 0) { settleAction(action, failure(action, prep, 'repo fetch failed'), { receiptsPath }); return; }
  const deployCmd = ['bash', '-lc', \`cd '\${dir}' && vercel link --yes --non-interactive --team \${cfg.scope} --project \${cfg.vercelProject} && vercel deploy --prod --yes --non-interactive --scope \${cfg.scope}\`];
  action.command = shellSummary(deployCmd);
  const out = await spawnCollect(deployCmd[0], deployCmd.slice(1));
  if (out.code !== 0) { settleAction(action, failure(action, out, 'vercel deploy failed'), { receiptsPath }); return; }
  const url = ((out.stdout || '').match(/https:\\/\\/[a-z0-9.-]*vercel\\.app/i) || [])[0] || null;
  settleAction(action, { status: 'deployed', actor: 'petrus', decided_at: action.decided_at, ran_at: action.ran_at, command: action.command, exit_code: 0, output_summary: url ? \`Deployed \${cfg.vercelProject}: \${url}\` : \`Deployed \${cfg.vercelProject}\` }, { receiptsPath });
}
`;
}
writeFileSync(f, s);
console.log('  patched src/confirmations.mjs');
PATCH

echo "[4/6] syntax-check"
node --check src/confirmations.mjs
node --check bin/iak-mcp-daemon.mjs
node --check scripts/action-request.mjs

echo "[5/6] commit on $BRANCH (author = ThinkOffApp account)"
git add -A
git -c user.name="ThinkOffApp" -c user.email="thinkoffbusiness@gmail.com" \
  commit -m "feat(daemon): clarity->clarity_build deploy executor (button-gated, MacBook-only)

Reconciles room_react + MacBook daemon mods with main's /actions executor and adds
executeDeploySite for project clarity. Installed by petrus (human owns the privileged
install); ClaudeMB only requests deploy_site(clarity).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

echo
echo "[6/6] DONE (code installed, NOT deployed)."
echo "NEXT (you do these):"
echo "  a) Restart the IAK daemon so it loads /actions (it's a child of your Antigravity IDE)."
echo "     Then verify it is back:  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8788/intents   (expect 200)"
echo "  b) Smoke test (no deploy, just a button):"
echo "     node scripts/action-request.mjs deploy_site --project clarity --decision-room clarity-dev --no-wait"
echo "  c) Merge Clarity PR #2 to main, THEN request a real deploy_site(clarity) and tap Approve on CodeWatch."
echo "Rollback if needed: cp /tmp/iak-backup/*.mjs to src/ and bin/, then restart the daemon."
