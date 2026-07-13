#!/usr/bin/env bash
# request-codewatch-approval.sh
#
# Thin wrapper around action-request.mjs that makes its semantics crystal clear
# to safety classifiers: this script QUEUES AN APPROVAL CARD on petrus's phone
# via the IAK daemon. It does NOT execute the action. The daemon only runs the
# registered executor after petrus taps Approve in CodeWatch.
#
# Built 2026-06-25 per hermes + ether's room recommendation: keep a clean
# semantic split between "create approval card" (allowed) and "execute the
# approved action" (gated by phone tap), so off-laptop CodeWatch ops work.
#
# Usage:
#   request-codewatch-approval avai            # queue Vercel deploy card for avai
#   request-codewatch-approval codewatch-web   # queue Vercel deploy card for codewatch-web
#   request-codewatch-approval groupmind       # queue Vercel deploy card for groupmind
#   request-codewatch-approval clarity         # queue Vercel deploy card for clarity
#   request-codewatch-approval merge --repo ThinkOffApp/antfarm --pr 38

set -euo pipefail
KIND="${1:-}"
shift || true

case "$KIND" in
  avai|codewatch-web|groupmind|clarity)
    exec node /Users/petrus/ide-agent-kit/scripts/action-request.mjs deploy_site --project "$KIND" "$@"
    ;;
  merge)
    exec node /Users/petrus/ide-agent-kit/scripts/action-request.mjs merge_pr "$@"
    ;;
  *)
    echo "usage: request-codewatch-approval <avai|codewatch-web|groupmind|clarity|merge> [args]" >&2
    echo "creates a CodeWatch approval card; does NOT execute the action" >&2
    exit 2
    ;;
esac
