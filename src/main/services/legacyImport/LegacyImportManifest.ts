import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isLegacyImportPathSegment,
  type LegacyImportSourceFingerprint,
  type LegacyImportSourceRef,
} from '@shared/types';
import { app, safeStorage } from 'electron';

const MANIFEST_VERSION = 1 as const;
const MANIFEST_FILENAME = 'legacy-import-manifest.json';

export type LegacyImportManifestStatus = 'importing' | 'complete' | 'failed';

export interface LegacyImportManifestRecord {
  dedupeKey: string;
  status: LegacyImportManifestStatus;
  source: LegacyImportSourceRef;
  sourcePath: string;
  sourceFingerprint: LegacyImportSourceFingerprint;
  workspacePath: string;
  title: string;
  logicalSessionId: string;
  targetPiSessionId: string;
  targetSessionFile?: string;
  startedAt: number;
  completedAt?: number;
  failedAt?: number;
  error?: string;
  cleanupPending?: boolean;
  integrity?: string;
}

interface ManifestFile {
  version: typeof MANIFEST_VERSION;
  records: LegacyImportManifestRecord[];
}

export interface LegacyImportManifestOptions {
  manifestPath?: string;
  integrityKeyPath?: string;
  integrityKey?: Buffer;
  writeAtomically?: (targetPath: string, data: ManifestFile) => Promise<void>;
}

async function writeJsonAtomically(targetPath: string, data: ManifestFile): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, targetPath);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

function defaultManifestPath(): string {
  if (!app?.getPath) throw new Error('Electron app userData path is unavailable');
  return path.join(app.getPath('userData'), MANIFEST_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) output[key] = stableValue(item);
  }
  return output;
}

function integrityPayload(record: LegacyImportManifestRecord): string {
  const { integrity: _integrity, ...unsigned } = record;
  return JSON.stringify(stableValue(unsigned));
}

function parseRecord(value: unknown): LegacyImportManifestRecord | null {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.sourceFingerprint))
    return null;
  if (
    typeof value.dedupeKey !== 'string' ||
    !['importing', 'complete', 'failed'].includes(String(value.status)) ||
    value.source.sourceKind !== 'claude-code' ||
    !isLegacyImportPathSegment(value.source.projectId) ||
    !isLegacyImportPathSegment(value.source.sourceSessionId) ||
    typeof value.sourcePath !== 'string' ||
    !path.isAbsolute(value.sourcePath) ||
    typeof value.workspacePath !== 'string' ||
    !path.isAbsolute(value.workspacePath) ||
    typeof value.title !== 'string' ||
    typeof value.logicalSessionId !== 'string' ||
    !isLegacyImportPathSegment(value.targetPiSessionId) ||
    typeof value.startedAt !== 'number' ||
    (value.cleanupPending !== undefined && typeof value.cleanupPending !== 'boolean') ||
    typeof value.integrity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.integrity) ||
    (value.targetSessionFile !== undefined &&
      (typeof value.targetSessionFile !== 'string' ||
        !path.isAbsolute(value.targetSessionFile) ||
        !path.basename(value.targetSessionFile).endsWith(`_${value.targetPiSessionId}.jsonl`)))
  ) {
    return null;
  }
  return value as unknown as LegacyImportManifestRecord;
}

export class LegacyImportManifest {
  private readonly configuredManifestPath?: string;
  private readonly configuredIntegrityKeyPath?: string;
  private integrityKey: Buffer | null;
  private readonly writeAtomically: (targetPath: string, data: ManifestFile) => Promise<void>;
  private records = new Map<string, LegacyImportManifestRecord>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: LegacyImportManifestOptions = {}) {
    this.configuredManifestPath = options.manifestPath;
    this.configuredIntegrityKeyPath = options.integrityKeyPath;
    this.integrityKey = options.integrityKey ? Buffer.from(options.integrityKey) : null;
    this.writeAtomically = options.writeAtomically ?? writeJsonAtomically;
  }

  async list(): Promise<LegacyImportManifestRecord[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async get(dedupeKey: string): Promise<LegacyImportManifestRecord | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const record = this.records.get(dedupeKey);
    return record ? { ...record } : undefined;
  }

  async reserve(record: LegacyImportManifestRecord): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.records.get(record.dedupeKey);
      if (
        existing?.status === 'complete' ||
        existing?.status === 'importing' ||
        (existing?.status === 'failed' && existing.cleanupPending !== false)
      ) {
        throw new Error(`Legacy import already reserved: ${record.dedupeKey}`);
      }
      this.records.set(
        record.dedupeKey,
        this.signRecord({ ...record, status: 'importing', integrity: undefined })
      );
      try {
        await this.flush();
      } catch (error) {
        if (existing) this.records.set(record.dedupeKey, existing);
        else this.records.delete(record.dedupeKey);
        throw error;
      }
    });
  }

  async updateImporting(
    dedupeKey: string,
    patch: Pick<LegacyImportManifestRecord, 'targetSessionFile'>
  ): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.records.get(dedupeKey);
      if (!existing || existing.status !== 'importing') {
        throw new Error(`Legacy import is not reserved: ${dedupeKey}`);
      }
      this.records.set(dedupeKey, this.signRecord({ ...existing, ...patch, integrity: undefined }));
      try {
        await this.flush();
      } catch (error) {
        this.records.set(dedupeKey, existing);
        throw error;
      }
    });
  }

  async complete(dedupeKey: string, targetSessionFile: string): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.records.get(dedupeKey);
      if (!existing || existing.status !== 'importing') {
        throw new Error(`Legacy import is not reserved: ${dedupeKey}`);
      }
      this.records.set(
        dedupeKey,
        this.signRecord({
          ...existing,
          status: 'complete',
          targetSessionFile,
          completedAt: Date.now(),
          failedAt: undefined,
          error: undefined,
          cleanupPending: false,
          integrity: undefined,
        })
      );
      try {
        await this.flush();
      } catch (error) {
        this.records.set(dedupeKey, existing);
        throw error;
      }
    });
  }

  async fail(dedupeKey: string, errorMessage: string, cleanupPending = true): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.records.get(dedupeKey);
      if (!existing) return;
      this.records.set(
        dedupeKey,
        this.signRecord({
          ...existing,
          status: 'failed',
          failedAt: Date.now(),
          error: errorMessage,
          cleanupPending,
          integrity: undefined,
        })
      );
      try {
        await this.flush();
      } catch (error) {
        this.records.set(dedupeKey, existing);
        throw error;
      }
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.ensureIntegrityKey();
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath(), 'utf8')) as unknown;
      if (
        isRecord(parsed) &&
        parsed.version === MANIFEST_VERSION &&
        Array.isArray(parsed.records)
      ) {
        for (const item of parsed.records) {
          const record = parseRecord(item);
          if (record && this.verifyRecord(record)) {
            this.records.set(record.dedupeKey, record);
          } else if (record) {
            console.warn('[legacy-import] Ignored a manifest record with invalid integrity');
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[legacy-import] Failed to load import manifest:', error);
      }
    }
    this.loaded = true;
  }

  private signRecord(record: LegacyImportManifestRecord): LegacyImportManifestRecord {
    if (!this.integrityKey) throw new Error('Legacy import integrity key is unavailable');
    const integrity = createHmac('sha256', this.integrityKey)
      .update(integrityPayload(record))
      .digest('hex');
    return { ...record, integrity };
  }

  private verifyRecord(record: LegacyImportManifestRecord): boolean {
    if (!this.integrityKey || !record.integrity) return false;
    const expected = createHmac('sha256', this.integrityKey)
      .update(integrityPayload(record))
      .digest();
    const actual = Buffer.from(record.integrity, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private integrityKeyPath(): string {
    return this.configuredIntegrityKeyPath ?? `${this.manifestPath()}.key`;
  }

  private async ensureIntegrityKey(): Promise<void> {
    if (this.integrityKey) return;
    const keyPath = this.integrityKeyPath();
    try {
      const encrypted = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64');
      const encoded = safeStorage.decryptString(encrypted);
      if (!/^[a-f0-9]{64}$/.test(encoded)) {
        throw new Error('Legacy import integrity key is corrupt');
      }
      this.integrityKey = Buffer.from(encoded, 'hex');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(keyPath), { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable for the legacy import manifest');
    }
    const encoded = randomBytes(32).toString('hex');
    const encrypted = safeStorage.encryptString(encoded).toString('base64');
    try {
      await writeFile(keyPath, encrypted, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.integrityKey = Buffer.from(encoded, 'hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const existingEncrypted = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64');
      const existing = safeStorage.decryptString(existingEncrypted);
      if (!/^[a-f0-9]{64}$/.test(existing)) {
        throw new Error('Legacy import integrity key is corrupt');
      }
      this.integrityKey = Buffer.from(existing, 'hex');
    }
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private manifestPath(): string {
    return this.configuredManifestPath ?? defaultManifestPath();
  }

  private flush(): Promise<void> {
    return this.writeAtomically(this.manifestPath(), {
      version: MANIFEST_VERSION,
      records: [...this.records.values()],
    });
  }
}
