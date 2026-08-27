#!/bin/bash
# Republish the Mac mini's host facts into its intent device slot.
#
# The DesktopAdapter publishes a thin slot on macOS (load_pct, mem_available_gb,
# idle_sec, active_app). The Pi's row shows model/temp/load/memory, so the Mini
# looked empty next to it in CodeWatch's Local devices (petrus 2026-08-19:
# "we need your stats in the table too").
#
# Static facts could be patched once, but load and free memory cannot: a value
# patched once freezes while the row still says "now", which is worse than an
# absent field. So this refreshes on the daemon's own cadence.
#
# temp_c and watts_w are deliberately NOT published: reading them on macOS needs
# root, and the fleet contract is that an unreadable sensor is omitted, never zeroed.
set -u
IAK_DIR="/Users/petrus/ide-agent-kit"
NODE="/opt/homebrew/bin/node"
CONFIG="$IAK_DIR/config/dogfood.json"
cd "$IAK_DIR"
while true; do
  LOAD1=$(sysctl -n vm.loadavg | awk '{print $2}')
  NCPU=$(sysctl -n hw.ncpu)
  read -r MEMT MEMA <<< "$(python3 -c "
import subprocess,re
total=int(subprocess.check_output(['sysctl','-n','hw.memsize']))/1e9
o=subprocess.check_output(['vm_stat']).decode()
ps=int(re.search(r'page size of (\d+)',o).group(1))
g=lambda k:int(re.search(k+r':\s+(\d+)',o).group(1))
avail=(g('Pages free')+g('Pages inactive')+g('Pages speculative'))*ps/1e9
print(f'{total:.1f} {avail:.1f}')")"
  $NODE bin/cli.mjs intent patch \
    kind=mac-mini cpu_count="$NCPU" load_1m="$LOAD1" \
    mem_total_gb="$MEMT" mem_available_gb="$MEMA" \
    memory="${MEMT}GB total, ${MEMA}GB available" \
    --config "$CONFIG" >/dev/null 2>&1 || true
  sleep 30
done
