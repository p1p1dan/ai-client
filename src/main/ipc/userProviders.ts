/**
 * H/17 L2 — IPC for the user-added AI services.
 *
 * Every payload is validated here rather than in the service: the renderer is
 * the untrusted side of this boundary, and the service's own errors are meant
 * to be about the SERVICE ("no such id", "the key was refused"), not about a
 * caller that sent a number where a string belongs.
 *
 * Nothing on this channel ever carries a stored key outward. `get` answers
 * with `hasApiKey`; an edit that omits `apiKey` keeps the one already stored.
 */

import { IPC_CHANNELS } from '@shared/types';
import {
  type FetchProviderModelsRequest,
  type FetchProviderModelsResult,
  isUserProviderApi,
  type UserProviderDraft,
  type UserProviderState,
  type UserProviderView,
} from '@shared/userProviders';
import { ipcMain } from 'electron';
import { getUserProviderService } from '../services/userProviders';

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid AI service request: ${field}`);
  return value;
}

function readDraft(payload: unknown): UserProviderDraft {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid AI service request');
  const raw = payload as Record<string, unknown>;
  if (!isUserProviderApi(raw.api)) throw new Error('Invalid AI service request: api');
  const draft: UserProviderDraft = {
    name: readString(raw.name, 'name'),
    baseUrl: readString(raw.baseUrl, 'baseUrl'),
    api: raw.api,
  };
  if (raw.id !== undefined) draft.id = readString(raw.id, 'id');
  // Absent and present-but-empty mean different things (keep the stored key vs.
  // a mistake), so `undefined` must survive this copy untouched.
  if (raw.apiKey !== undefined) draft.apiKey = readString(raw.apiKey, 'apiKey');
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) throw new Error('Invalid AI service request: models');
    draft.models = raw.models.map((model, index) => readString(model, `models[${index}]`));
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error('Invalid AI service request: enabled');
    draft.enabled = raw.enabled;
  }
  return draft;
}

function readFetchRequest(payload: unknown): FetchProviderModelsRequest {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid AI service request');
  const raw = payload as Record<string, unknown>;
  if (!isUserProviderApi(raw.api)) throw new Error('Invalid AI service request: api');
  const request: FetchProviderModelsRequest = {
    baseUrl: readString(raw.baseUrl, 'baseUrl'),
    api: raw.api,
  };
  if (raw.apiKey !== undefined) request.apiKey = readString(raw.apiKey, 'apiKey');
  if (raw.id !== undefined) request.id = readString(raw.id, 'id');
  return request;
}

export function registerUserProviderHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USER_PROVIDERS_GET, (): UserProviderState => {
    return getUserProviderService().state();
  });

  ipcMain.handle(
    IPC_CHANNELS.USER_PROVIDERS_UPSERT,
    (_event, payload: unknown): Promise<UserProviderView> => {
      return getUserProviderService().upsert(readDraft(payload));
    }
  );

  ipcMain.handle(IPC_CHANNELS.USER_PROVIDERS_REMOVE, (_event, payload: unknown): Promise<void> => {
    return getUserProviderService().remove(readString(payload, 'id'));
  });

  ipcMain.handle(
    IPC_CHANNELS.USER_PROVIDERS_SET_ENABLED,
    (_event, payload: unknown): Promise<UserProviderView> => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid AI service request');
      const raw = payload as Record<string, unknown>;
      if (typeof raw.enabled !== 'boolean') throw new Error('Invalid AI service request: enabled');
      return getUserProviderService().setEnabled(readString(raw.id, 'id'), raw.enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.USER_PROVIDERS_FETCH_MODELS,
    (_event, payload: unknown): Promise<FetchProviderModelsResult> => {
      return getUserProviderService().fetchModels(readFetchRequest(payload));
    }
  );
}
