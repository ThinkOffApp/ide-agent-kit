// SPDX-License-Identifier: AGPL-3.0

export { IntentClient } from './client.js';
export { IAKAdapter } from './adapters/iak.js';
export { OpenClawAdapter } from './adapters/openclaw.js';
export { DesktopAdapter } from './adapters/desktop.js';
export { BrowserAdapter } from './adapters/browser.js';
export { collectHostTelemetry } from './host-telemetry.js';
export { ServedModelProbe, servedModelEntry, readVerdict, parseEndpoint, VERDICTS } from './served-model.js';
export {
  ModelAvailabilityProbe,
  describeLocalModels,
  scanLocalModels,
  scanRepoDir,
  measureMemory,
  measureMemoryBudget,
  measureAvailableNow,
  classifyFit,
  heartbeatFields,
  rank,
  defaultSearchRoots,
  AVAILABILITY,
  BUDGET_SOURCES,
  LABELS,
  KV_CACHE_HEADROOM_FRACTION,
} from './model-availability.js';
