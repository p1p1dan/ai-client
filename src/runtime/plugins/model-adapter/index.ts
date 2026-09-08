/**
 * P0-4 - plugin-model-adapter, the runtime's only door to a provider.
 *
 * ARD D2 makes `pi-ai` the single external protocol layer, so this plugin is
 * the one place that knows what a provider is. Everything above it (the agent
 * loop today; tools, context and session later) sees only
 * {@link ModelAdapterService}, which is why swapping the on-disk catalog for an
 * injected registry - what the offline smoke lane does - needs no change
 * anywhere else.
 */

import { createModels, type Models, type Provider } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
import {
  HOST_IO_SERVICE,
  MODEL_SERVICE,
  type ModelAdapterService,
  type ModelCatalogSource,
  type ResolvedModel,
  RuntimeConfigError,
  type RuntimeModelRef,
} from '../../contracts.ts';
import { buildProviderModels } from './binding.ts';
import type { CatalogProvider, PiCatalog } from './catalog.ts';

export interface ModelAdapterConfig {
  catalog?: PiCatalog;
  /** Directory holding `models.json` / `auth.json`. Ignored when `providers` is set. */
  agentDir?: string | null;
  /**
   * Pre-built pi-ai providers that REPLACE the on-disk catalog.
   *
   * The offline lane (`smoke/runOnce.ts --offline`) passes pi-ai's own
   * `fauxProvider()` here. It is a config field rather than a subclass or a
   * test double because the substitution has to be visible in the trace's
   * version stamp: a run against a faux provider proves the graph is wired,
   * NOT that a real endpoint answered, and those two claims must never be
   * confusable after the fact.
   */
  providers?: readonly Provider[];
  env?: NodeJS.ProcessEnv;
}

interface Binding {
  ref: RuntimeModelRef;
  models: Models;
  requestKey: string;
}

export class ModelAdapterPlugin extends Service implements ModelAdapterService {
  static inject = [HOST_IO_SERVICE];
  readonly source: ModelCatalogSource;
  private readonly bindings = new Map<string, Binding>();
  private readonly order: RuntimeModelRef[] = [];

  constructor(ctx: Context, config: ModelAdapterConfig) {
    super(ctx, MODEL_SERVICE);
    this.source = config.providers
      ? this.bindInjected(config.providers)
      : this.bindCatalog(config.catalog);
  }

  list(): readonly RuntimeModelRef[] {
    return this.order;
  }

  defaultRef(): RuntimeModelRef | undefined {
    return this.order[0];
  }

  resolve(ref: RuntimeModelRef): ResolvedModel {
    const binding = this.bindings.get(keyOf(ref));
    if (!binding) {
      throw new RuntimeConfigError(
        'model_not_in_catalog',
        `no model "${ref.provider}/${ref.id}" in the catalog (${this.order.length} available)`
      );
    }
    const model = binding.models.getModel(ref.provider, ref.id);
    if (!model) {
      // Unreachable through `bindCatalog`/`bindInjected`, which register the
      // ref and the model together. Kept because pi-ai's registry is mutable:
      // a future plugin that removes a provider must fail here loudly rather
      // than hand the loop an undefined model.
      throw new RuntimeConfigError(
        'model_registry_desync',
        `catalog lists "${ref.provider}/${ref.id}" but its pi-ai registry does not`
      );
    }
    return { ref: binding.ref, model, models: binding.models, requestKey: binding.requestKey };
  }

  private bindCatalog(catalog: PiCatalog | undefined): ModelCatalogSource {
    if (!catalog) {
      throw new RuntimeConfigError(
        'agent_dir_unset',
        'no catalog directory - set AICLIENT_RUNTIME_AGENT_DIR or PI_CODING_AGENT_DIR, or pass providers explicitly'
      );
    }
    for (const provider of catalog.providers) this.bindProvider(provider);
    return {
      kind: 'agent-dir',
      dir: catalog.dir,
      providerCount: catalog.providers.length,
      modelCount: this.order.length,
    };
  }

  private bindProvider(provider: CatalogProvider): void {
    const models = buildProviderModels(provider);
    for (const model of provider.models) {
      this.register({
        ref: { provider: provider.id, id: model.id },
        models,
        requestKey: provider.apiKey,
      });
    }
  }

  private bindInjected(providers: readonly Provider[]): ModelCatalogSource {
    for (const provider of providers) {
      const models = createModels();
      models.setProvider(provider);
      for (const model of provider.getModels()) {
        this.register({
          ref: { provider: model.provider, id: model.id },
          models,
          // An injected provider carries its own auth in its `resolve`, so
          // there is no separate key for the loop to present.
          requestKey: '',
        });
      }
    }
    return { kind: 'injected', providerCount: providers.length, modelCount: this.order.length };
  }

  private register(binding: Binding): void {
    const key = keyOf(binding.ref);
    // First writer wins, so catalog order decides `defaultRef()` and a
    // duplicate row later in `models.json` cannot silently retarget a model id
    // the user already picked.
    if (this.bindings.has(key)) return;
    this.bindings.set(key, binding);
    this.order.push(binding.ref);
  }
}

function keyOf(ref: RuntimeModelRef): string {
  return `${ref.provider} ${ref.id}`;
}
