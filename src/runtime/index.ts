/**
 * Public surface of the self-owned runtime (ARD `docs/plans/2026-09-08-runtime-evolution-ard.md`).
 *
 * Everything outside `src/runtime/` - the worker bootstrap in P4-1, the smoke
 * runner today - imports from here and nothing deeper, so the plugin layout
 * underneath stays free to change while P1/P2/P3 build in parallel.
 */

export type {
  PermissionGear,
  RuntimeMode,
  RuntimePermissionSettings,
} from '../shared/types/runtimePermission.ts';
export {
  migratePermissionTier,
  PERMISSION_GEAR_LABELS,
  RUNTIME_MODE_LABELS,
  resolveRuntimePermission,
} from '../shared/types/runtimePermission.ts';
export type { RuntimeBootstrapOptions, RuntimeHandle } from './bootstrap.ts';
export { createRuntime, RUNTIME_CONFIG_VERSION } from './bootstrap.ts';
export type {
  AgentLoopService,
  DeferredServiceDeclaration,
  ModelAdapterService,
  ModelCatalogSource,
  ResolvedModel,
  RunTrace,
  RuntimeCarrier,
  RuntimeExecAdapter,
  RuntimeExecRequest,
  RuntimeExecResult,
  RuntimeExecService,
  RuntimeHostConfig,
  RuntimeHostIoService,
  RuntimeModelRef,
  RuntimeReadOptions,
  RuntimeReadResult,
  RuntimeRunRequest,
  RuntimeRunResult,
  TraceRun,
  TraceService,
  TraceStep,
} from './contracts.ts';
export {
  DEFERRED_REASON_MARKER,
  DEFERRED_SERVICES,
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  LOOP_SERVICE,
  MODEL_SERVICE,
  P0_SERVICES,
  RUNTIME_SERVICES,
  RuntimeConfigError,
  TRACE_SERVICE,
} from './contracts.ts';
export type { RuntimeBackend, RuntimeFlags } from './flags.ts';
export {
  PI_AGENT_DIR_ENV,
  RUNTIME_AGENT_DIR_ENV,
  RUNTIME_BACKEND_ENV,
  RUNTIME_TRACE_DIR_ENV,
  readRuntimeFlags,
} from './flags.ts';
export { standaloneHost } from './host/config.ts';
export { RuntimeHostError } from './host/errors.ts';
export type { AgentLoopConfig } from './plugins/agent-loop/index.ts';
export { DEFAULT_AGENT_LOOP_CONFIG } from './plugins/agent-loop/index.ts';
export type { CatalogModel, CatalogProvider, PiCatalog } from './plugins/model-adapter/catalog.ts';
export { readPiCatalog } from './plugins/model-adapter/catalog.ts';
export type { ModelAdapterConfig } from './plugins/model-adapter/index.ts';
export { createRuntimeApprovalBridge } from './plugins/permissions/bridge.ts';
export type {
  PermissionConfig,
  PermissionScope,
  RuntimePermissionsService,
} from './plugins/permissions/index.ts';
export { PERMISSIONS_SERVICE } from './plugins/permissions/index.ts';
export { modeSegment, permissionGearSegment } from './plugins/permissions/prompt.ts';
export type { RuntimeToolsService, ToolsConfig } from './plugins/tools/index.ts';
export { TOOLS_SERVICE } from './plugins/tools/index.ts';
export {
  type CompactionFamily,
  type NewContextOptions,
  newContextTool,
} from './plugins/tools/new-context.ts';
export { toolSegments } from './plugins/tools/prompt.ts';
