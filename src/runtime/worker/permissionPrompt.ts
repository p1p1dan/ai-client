// Thin re-export (dsh-rebase P1-6a): the permission card emitter lives in
// src/shared/permissions/cardEmitter.ts, shared with the DSH host.
export {
  createPermissionPrompt,
  type PermissionPrompt,
  type PermissionPromptOptions,
} from '../../shared/permissions/cardEmitter.ts';
