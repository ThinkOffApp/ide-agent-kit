// SPDX-License-Identifier: AGPL-3.0

export { IntentClient } from './client.js';
export { IAKAdapter } from './adapters/iak.js';
export { OpenClawAdapter } from './adapters/openclaw.js';
export { DesktopAdapter } from './adapters/desktop.js';
export { BrowserAdapter } from './adapters/browser.js';
export { collectHostTelemetry } from './host-telemetry.js';
export { ServedModelProbe, servedModelEntry, readVerdict, parseEndpoint, VERDICTS } from './served-model.js';
export {
  TensorFoldMonitor,
  probeTensorFold,
  collectTensorFoldStatus,
  parsePrometheus,
  histogramQuantile,
  TENSORFOLD_ENGINE,
  STATUS_SCHEMA as TENSORFOLD_STATUS_SCHEMA,
  METRICS_STATES as TENSORFOLD_METRICS_STATES,
} from './tensorfold-status.js';
export { discoverTensorFoldEngines } from './tensorfold-discovery.js';
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
