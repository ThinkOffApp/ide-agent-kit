# AgentOS — dynamic hardware→model→agent allocation

**Status:** draft v2 for review (v1 died with a scratchpad wipe on 2026-08-27;
this one lives in the repo). **Issue:** THI-31.

## The idea

You own a set of machines. AgentOS keeps each of them running the model that
best fits its hardware and your workflows, exposes every model as an agent in
your rooms, and lets the agents themselves propose better arrangements — with
a human approval gate between proposal and execution.

The vision sentence it implements, verbatim from the owner: *"a dynamic system
where available HW gets models installed which best suit the HW and your
workflows. They all become agents and figure out together the optimal
organization."*

## Validating case study (done by hand, 2026-08-27)

Every step below was executed manually the night before this spec, swapping a
Strix Halo box from two small models to Qwen3.8-Flash-Next 125B. The module
automates exactly this sequence:

1. Measured the box (disk, unified memory, VRAM carve, GPU backend).
2. Resolved the requested model to concrete artifacts (HF repo, quant, shard
   sizes) and checked fit against measured memory — including runtime KV cost
   computed from the GGUF's own metadata, not vendor claims.
3. Discovered the runtime could not load the new architecture; fetched and
   built the required llama.cpp branch in a SEPARATE directory, leaving the
   serving build untouched.
4. Downloaded weights in parallel with the build, old servers still serving.
5. Swap: stop old servers by PID, start new server, verify with a REAL
   completion (answer content checked, not HTTP 200).
6. Repointed both room handles at the new endpoint, updated their identity
   prompts, restarted the bridge, verified end-to-end in the room.
7. Kept old weights + old build on disk: rollback is one command.

Total wall time ~35 minutes, zero downtime until step 5.

## Components (build order)

### 1. Probe — hardware inventory
Per box: total/free disk, RAM, VRAM carve (`mem_info_vram_total`), GTT size,
GPU backend (Vulkan/Metal/CUDA/ROCm), CPU count, measured net links.
Output: `inventory.json` per host, refreshed on join and on demand.
Extends the existing fleet host telemetry rather than duplicating it.

### 2. Catalog — model fit rules
A model entry: artifact source (HF repo + quant path), disk size per shard,
total-memory requirement per quant (the unsloth-style table, machine-readable),
required runtime (mainline llama.cpp version, or a named PR branch), context
KV cost derivable from GGUF metadata. Fit = f(inventory, entry) → yes/no/tight.

### 3. Allocator — the case study as code
`allocate(box, model)`: fit-check → download (resumable, checksummed) →
runtime check/build (never in the serving dir) → staged swap with real-answer
verification → handle repoint → rollback script emitted BEFORE the swap runs.
Every state-changing step goes through the approval gate as one intent.

### 4. Lifecycle — models as agents
Register handle, wire it to an endpoint through the bridge or an agent runtime
(e.g. Hermes), health = a real question answered on schedule (the QA runner
pattern: delta-log, silence when fine), retire cleanly.

### 5. Reallocation loop — agents figure it out together
Agents post proposals ("box X idles, model Y fits it and workflow Z queues")
into the room; the approval gate turns a human yes into an allocator run.
No autonomous swaps: proposals are free, execution is gated.

## Non-goals (v1)

- No multi-box tensor sharding (VulkanVM / RPC territory — tracked separately).
- No automatic model *choice* by benchmark; the catalog ranks, the human picks.
- No cloud models; this is for hardware the owner controls.

## Interfaces

- CLI: `iak agentos probe|fit|allocate|status`.
- The intent/approval gate is the ONLY path for state-changing operations.
- Room-facing: proposals and results are plain room messages from the agents.

## Open questions for review

1. Catalog format: in-repo JSON vs a room document (repo JSON survives wipes).
2. Where the allocator runs: on the target box vs from a coordinator.
3. Multi-tenant boxes (serve + bench windows) — encode claudeMB's "agreed
   windows" rule as a first-class lease?
