// Thin re-export (dsh-rebase P1-16 prep): the directory roots, merge and
// pin-resolution rules live in src/shared/subagentCatalogRoots.ts. Export
// names and behaviour are unchanged. P1-12 deletes this file with the runtime.
export {
  applySubagentActivation,
  loadSubagentCatalog,
  resolveSubagentPin,
  type SubagentCatalog,
  type SubagentCatalogConfig,
  type SubagentDiagnostic,
  type SubagentDiagnosticCode,
  type SubagentDocumentSource,
  type SubagentFileKind,
  type SubagentModelRef,
  subagentPinDiagnostics,
  subagentRoots,
} from '../../../shared/subagentCatalogRoots.ts';
