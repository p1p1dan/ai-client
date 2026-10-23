import type { PluginStatus } from '@shared/plugins/api';
import { PLUGIN_EVENTS, PLUGIN_TIMEOUTS_MS } from '@shared/plugins/protocol';
import type { PluginInstallResult, PluginRunState, PluginView } from '@shared/plugins/view';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionControlChange, SessionController } from '@shared/types/sessionControl';
import type { ChatCaller } from '../chat/chatCaller';
import { SessionLiveJournal } from '../remoteAccess/sessionLiveJournal';
import { type PluginAuditEntry, PluginBroker } from './pluginBroker';
import { type PluginLaunch, PluginProcess, toWireError } from './pluginProcess';
import type { InstalledPlugin, PluginStore } from './pluginStore';

/**
 * Runs the enabled plugins (plugin-system README §3, PI-Desktop ADR 0040).
 *
 * - Start: spawn, activate, then start each declared service.
 * - A plugin that dies on its own is restarted after 1s, 2s, 4s, 8s, 16s; after
 *   five tries it stays `failed`. One that stayed up 60s starts the count over.
 *   The user enabling or disabling it cancels whatever was pending.
 * - The chat journal (`SessionLiveJournal`) records only while some running
 *   plugin holds `chat.read`: a user with no such plugin pays nothing.
 */

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const HEALTHY_AFTER_MS = 60_000;

export interface PluginManagerDeps {
  store: PluginStore;
  launch(plugin: InstalledPlugin): PluginLaunch;
  startProcess?: typeof PluginProcess.start;
  invokeChat(channel: string, caller: ChatCaller, args: unknown[]): Promise<unknown>;
  onChatRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  sessionControl: {
    get(sessionId: string): SessionController;
    acquireForClient(
      sessionId: string,
      client: { ownerId: number; pluginId: string; label: string }
    ): void;
    releaseOwner(ownerId: number): void;
    onChange(listener: (change: SessionControlChange) => void): () => void;
  };
  allocateOwnerId(): number;
  appendAudit(entry: PluginAuditEntry): void;
  log(pluginId: string, level: 'info' | 'warn' | 'error', message: string): void;
  /** The list changed; the Plugins page re-renders from this. */
  notify(views: PluginView[]): void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface Runtime {
  state: PluginRunState;
  generation: number;
  process?: PluginProcess;
  broker?: PluginBroker;
  chatSubscribed: boolean;
  services: Map<string, 'stopped' | 'running' | 'failed'>;
  status?: PluginStatus;
  lastError?: string;
  restartCount: number;
  restartTimer?: NodeJS.Timeout;
  startedAt?: number;
}

export class PluginManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly startProcess: typeof PluginProcess.start;
  private journal: SessionLiveJournal | undefined;
  private stopChatTap: (() => void) | undefined;
  private readonly stopControlTap: () => void;

  constructor(private readonly deps: PluginManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    this.startProcess = deps.startProcess ?? PluginProcess.start;
    this.stopControlTap = deps.sessionControl.onChange((change) => {
      for (const [id, runtime] of this.runtimes) {
        const plugin = this.deps.store.get(id);
        if (runtime.state !== 'running' || !plugin?.manifest.permissions.length) continue;
        runtime.process?.emit(PLUGIN_EVENTS.sessionControlChanged, change);
      }
    });
  }

  /** Start every enabled plugin; failures are recorded per plugin, never thrown. */
  async startAll(): Promise<void> {
    for (const plugin of this.deps.store.list().plugins) {
      if (plugin.enabled) await this.start(plugin.manifest.id);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
    this.stopControlTap();
  }

  /** Quit without waiting: every plugin process is killed. */
  killAllSync(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.generation += 1;
      runtime.process?.killNow();
      runtime.process = undefined;
    }
  }

  list(): PluginView[] {
    const { plugins } = this.deps.store.list();
    return plugins.map((plugin) => this.view(plugin));
  }

  /** Install or update; a running copy is stopped and comes back on the new code. */
  async install(file: string): Promise<PluginInstallResult> {
    let installed: InstalledPlugin;
    try {
      installed = this.deps.store.installPackage(file);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const id = installed.manifest.id;
    if ((this.runtimes.get(id)?.state ?? 'stopped') !== 'stopped') await this.stop(id);
    if (installed.enabled) await this.start(id);
    this.changed();
    return { ok: true, plugin: this.view(installed) };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.deps.store.setEnabled(id, enabled);
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.restartCount = 0;
    if (enabled) await this.start(id);
    else await this.stop(id);
    this.changed();
  }

  async uninstall(id: string): Promise<void> {
    await this.stop(id);
    this.runtimes.delete(id);
    this.deps.store.uninstall(id);
    this.changed();
  }

  setSetting(id: string, key: string, value: unknown): void {
    const plugin = this.deps.store.get(id);
    if (!plugin) throw new Error(`plugin_not_found: no plugin ${id}`);
    this.deps.store.writeSetting(plugin.manifest, key, value);
    const runtime = this.runtimes.get(id);
    if (runtime?.state === 'running') {
      runtime.process?.emit(
        PLUGIN_EVENTS.settingsChanged,
        this.deps.store.readSettings(plugin.manifest)
      );
    }
    this.changed();
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {
        state: 'stopped',
        generation: 0,
        chatSubscribed: false,
        services: new Map(),
        restartCount: 0,
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private async start(id: string): Promise<void> {
    const plugin = this.deps.store.get(id);
    if (!plugin?.enabled) return;
    const runtime = this.runtime(id);
    if (runtime.state === 'starting' || runtime.state === 'running') return;
    if (runtime.restartTimer) {
      this.clearTimer(runtime.restartTimer);
      runtime.restartTimer = undefined;
    }
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.state = 'starting';
    runtime.lastError = undefined;
    runtime.services = new Map(plugin.manifest.contributes.services.map((s) => [s.id, 'stopped']));
    this.changed();

    const { manifest } = plugin;
    const broker = new PluginBroker(manifest, {
      invokeChat: (channel, caller, args) => this.deps.invokeChat(channel, caller, args),
      snapshot: (sessionId) => this.ensureJournal().snapshot(sessionId),
      since: (cursor) => this.ensureJournal().since(cursor),
      getController: (sessionId) => this.deps.sessionControl.get(sessionId),
      acquireForClient: (sessionId, client) =>
        this.deps.sessionControl.acquireForClient(sessionId, client),
      releaseOwner: (ownerId) => this.deps.sessionControl.releaseOwner(ownerId),
      allocateOwnerId: () => this.deps.allocateOwnerId(),
      readSettings: () => this.deps.store.readSettings(manifest),
      writeSetting: (key, value) => {
        this.deps.store.writeSetting(manifest, key, value);
        this.changed();
      },
      setStatus: (status) => {
        runtime.status = status;
        this.changed();
      },
      setChatSubscribed: (subscribed) => {
        runtime.chatSubscribed = subscribed;
      },
      audit: (entry) => this.deps.appendAudit(entry),
      now: this.now,
    });
    runtime.broker = broker;
    this.refreshChatTap();

    let process: PluginProcess;
    try {
      process = await this.startProcess(
        this.deps.launch(plugin),
        { t: 'init', pluginId: id, manifest, pluginDir: plugin.dir, dataDir: plugin.dataDir },
        {
          onHostCall: (method, args) => broker.handle(method, args),
          onLog: (level, message) => this.deps.log(id, level, message),
          onExit: (info) => this.onExit(id, generation, info),
        }
      );
    } catch (error) {
      if (runtime.generation !== generation) return;
      this.fail(runtime, broker, error);
      return;
    }
    if (runtime.generation !== generation) {
      await process.stop();
      return;
    }
    runtime.process = process;
    runtime.startedAt = this.now();
    for (const service of manifest.contributes.services) {
      try {
        await process.call('service.start', [service.id], PLUGIN_TIMEOUTS_MS.service + 1_000);
        runtime.services.set(service.id, 'running');
      } catch (error) {
        runtime.services.set(service.id, 'failed');
        runtime.lastError = `service ${service.id}: ${toWireError(error).message}`;
        this.deps.log(id, 'error', runtime.lastError);
      }
    }
    if (runtime.generation !== generation) return;
    runtime.state = 'running';
    this.changed();
  }

  private async stop(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (runtime.restartTimer) {
      this.clearTimer(runtime.restartTimer);
      runtime.restartTimer = undefined;
    }
    runtime.generation += 1;
    const { process, broker } = runtime;
    runtime.process = undefined;
    runtime.broker = undefined;
    runtime.chatSubscribed = false;
    runtime.state = 'stopped';
    runtime.status = undefined;
    for (const serviceId of runtime.services.keys()) runtime.services.set(serviceId, 'stopped');
    broker?.releaseAllClients();
    this.refreshChatTap();
    if (process) {
      for (const serviceId of [...runtime.services.keys()].reverse()) {
        await process
          .call('service.stop', [serviceId], PLUGIN_TIMEOUTS_MS.service + 1_000)
          .catch(() => undefined);
      }
      await process.stop();
    }
    this.changed();
  }

  private onExit(
    id: string,
    generation: number,
    info: { code: number | null; signal: string | null; expected: boolean }
  ): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.generation !== generation || info.expected) return;
    const uptime = runtime.startedAt === undefined ? 0 : this.now() - runtime.startedAt;
    if (uptime >= HEALTHY_AFTER_MS) runtime.restartCount = 0;
    this.fail(
      runtime,
      runtime.broker,
      new Error(`PLUGIN_CRASHED: exited with ${info.code ?? info.signal}`)
    );
    const plugin = this.deps.store.get(id);
    const autoRestart = plugin?.manifest.contributes.services.every((s) => s.autoRestart !== false);
    if (!plugin?.enabled || !autoRestart || runtime.restartCount >= RESTART_DELAYS_MS.length) {
      this.changed();
      return;
    }
    const delay = RESTART_DELAYS_MS[runtime.restartCount] ?? 30_000;
    runtime.restartCount += 1;
    runtime.restartTimer = this.setTimer(() => {
      runtime.restartTimer = undefined;
      void this.start(id);
    }, delay);
    this.changed();
  }

  private fail(runtime: Runtime, broker: PluginBroker | undefined, error: unknown): void {
    runtime.state = 'failed';
    runtime.lastError = error instanceof Error ? error.message : String(error);
    runtime.process = undefined;
    runtime.broker = undefined;
    runtime.chatSubscribed = false;
    for (const serviceId of runtime.services.keys()) runtime.services.set(serviceId, 'failed');
    broker?.releaseAllClients();
    this.refreshChatTap();
    this.changed();
  }

  /** Record chat events only while a running (or starting) plugin may read them. */
  private refreshChatTap(): void {
    const wanted = [...this.runtimes].some(
      ([id, runtime]) =>
        runtime.broker !== undefined &&
        this.deps.store.get(id)?.manifest.permissions.includes('chat.read')
    );
    if (wanted && !this.stopChatTap) {
      this.journal = new SessionLiveJournal();
      this.stopChatTap = this.deps.onChatRuntimeEvent((event) => this.fanOut(event));
    } else if (!wanted && this.stopChatTap) {
      this.stopChatTap();
      this.stopChatTap = undefined;
      this.journal = undefined;
    }
  }

  private ensureJournal(): SessionLiveJournal {
    if (!this.journal) this.journal = new SessionLiveJournal();
    return this.journal;
  }

  private fanOut(event: RuntimeEvent): void {
    const cursor = this.ensureJournal().record(event);
    for (const runtime of this.runtimes.values()) {
      if (runtime.chatSubscribed && runtime.state === 'running') {
        runtime.process?.emit(PLUGIN_EVENTS.chatEvent, { cursor, event });
      }
    }
  }

  private view(plugin: InstalledPlugin): PluginView {
    const runtime = this.runtimes.get(plugin.manifest.id);
    const { manifest } = plugin;
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: manifest.author } : {}),
      permissions: manifest.permissions,
      netHosts: manifest.net?.hosts ?? [],
      enabled: plugin.enabled,
      state: runtime?.state ?? 'stopped',
      restartCount: runtime?.restartCount ?? 0,
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime?.status ? { status: runtime.status } : {}),
      services: manifest.contributes.services.map((service) => ({
        id: service.id,
        ...(service.title ? { title: service.title } : {}),
        state: runtime?.services.get(service.id) ?? 'stopped',
      })),
      settings: this.deps.store.settingsView(manifest),
    };
  }

  private changed(): void {
    try {
      this.deps.notify(this.list());
    } catch (error) {
      console.warn('[plugins] notify failed:', error);
    }
  }
}
