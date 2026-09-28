// Thin re-export (dsh-rebase P1-16 prep): server declarations live in src/shared/mcp/config.ts.
export {
  hostServerBudget,
  type LoadedMcpConfig,
  loadMcpConfig,
  MAX_CONFIG_BYTES,
  MAX_SERVERS,
  type McpConfigDiagnostic,
  type McpConfigFiles,
  type McpConfigRoots,
  type McpConfigSource,
  type McpServerConfig,
  mcpConfigFiles,
  mcpConfigSource,
  sessionServerBudget,
  workerSlotBudget,
} from '../../../shared/mcp/config.ts';
