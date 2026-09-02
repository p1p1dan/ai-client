import type { AgentModelOption } from '@shared/types/agentCatalog';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import type { CommonAISettings } from '@shared/types/ai';
import { useEffect } from 'react';
import { effortsForModel, reconcileEffortForModel } from '@/components/chat/efforts';
import { usePiModelCatalog } from '@/components/chat/usePiModelCatalog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  defaultBranchNameGeneratorSettings,
  defaultCodeReviewPromptEn,
  defaultCodeReviewPromptZh,
  defaultCommitPromptEn,
  defaultCommitPromptZh,
  useSettingsStore,
} from '@/stores/settings';

type FeatureKey = 'commitMessageGenerator' | 'codeReview' | 'branchNameGenerator';

type FeatureSettings = CommonAISettings & {
  enabled: boolean;
  timeout?: number;
  maxDiffLines?: number;
  language?: string;
  prompt: string;
};

const AUTOMATIC = '__automatic__';

function ModelField({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (value: string) => void;
  models: readonly AgentModelOption[];
}) {
  const selected = value && models.some((model) => model.id === value) ? value : AUTOMATIC;
  return (
    <Select
      value={selected}
      onValueChange={(next) => next && onChange(next === AUTOMATIC ? '' : next)}
    >
      <SelectTrigger className="w-64">
        <SelectValue>
          {models.find((model) => model.id === selected)?.label ?? 'Automatic'}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function EffortField({
  value,
  model,
  onChange,
}: {
  value: SessionEffortLevel | undefined;
  model: AgentModelOption | undefined;
  onChange: (value: SessionEffortLevel | undefined) => void;
}) {
  const options = effortsForModel(model);
  const reconciled = reconcileEffortForModel(value, model);

  useEffect(() => {
    if (value && reconciled === 'default') onChange(undefined);
  }, [onChange, reconciled, value]);

  return (
    <Select
      value={reconciled}
      onValueChange={(next) =>
        next && onChange(next === 'default' ? undefined : (next as SessionEffortLevel))
      }
    >
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="default">Automatic</SelectItem>
        {options.map((effort) => (
          <SelectItem key={effort.id} value={effort.id}>
            {effort.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function AISettings() {
  const { t, locale } = useI18n();
  const { catalog } = usePiModelCatalog('ready');
  const models = catalog?.models ?? [];
  const settings = useSettingsStore();
  const features: Array<{ key: FeatureKey; title: string; description: string }> = [
    {
      key: 'commitMessageGenerator',
      title: t('Commit Message Generator'),
      description: t('Auto-generate commit messages using AI'),
    },
    {
      key: 'codeReview',
      title: t('Code Review'),
      description: t('Review changes with AI assistance'),
    },
    {
      key: 'branchNameGenerator',
      title: t('Branch Name Generator'),
      description: t('Generate branch names with AI'),
    },
  ];
  const defaults = {
    commitMessageGenerator: {
      prompt: locale === 'zh' ? defaultCommitPromptZh : defaultCommitPromptEn,
    },
    codeReview: {
      prompt: locale === 'zh' ? defaultCodeReviewPromptZh : defaultCodeReviewPromptEn,
    },
    branchNameGenerator: { prompt: defaultBranchNameGeneratorSettings.prompt },
  };
  const setFeature = (key: FeatureKey, patch: Partial<FeatureSettings>) => {
    switch (key) {
      case 'commitMessageGenerator':
        settings.setCommitMessageGenerator(patch);
        break;
      case 'codeReview':
        settings.setCodeReview(patch);
        break;
      case 'branchNameGenerator':
        settings.setBranchNameGenerator(patch);
        break;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('AI Features')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Configure AI-powered features for code generation and review')}
        </p>
      </div>
      {features.map(({ key, title, description }) => {
        const feature = settings[key] as FeatureSettings;
        const selectedModel = models.find((model) => model.id === feature.model);
        return (
          <section key={key} className="space-y-4 border-t pt-6">
            <div>
              <h4 className="text-base font-medium">{title}</h4>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('Enable Generator')}</span>
              <Switch
                checked={feature.enabled}
                onCheckedChange={(enabled) => setFeature(key, { enabled })}
              />
            </div>
            {feature.enabled && (
              <div className="space-y-4">
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <span className="text-sm font-medium">{t('Model')}</span>
                  <ModelField
                    value={feature.model ?? ''}
                    onChange={(model) => setFeature(key, { model, effort: undefined })}
                    models={models}
                  />
                </div>
                <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                  <span className="text-sm font-medium">{t('Effort')}</span>
                  <EffortField
                    value={feature.effort}
                    model={selectedModel}
                    onChange={(effort) => setFeature(key, { effort })}
                  />
                </div>
                {'maxDiffLines' in feature && (
                  <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                    <span className="text-sm font-medium">{t('Max Diff Lines')}</span>
                    <Input
                      type="number"
                      className="w-32"
                      value={feature.maxDiffLines}
                      onChange={(event) =>
                        setFeature(key, { maxDiffLines: Number(event.target.value) || 1000 })
                      }
                    />
                  </div>
                )}
                {'timeout' in feature && (
                  <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                    <span className="text-sm font-medium">{t('Timeout')}</span>
                    <Input
                      type="number"
                      className="w-32"
                      value={feature.timeout}
                      onChange={(event) =>
                        setFeature(key, { timeout: Number(event.target.value) || 60 })
                      }
                    />
                  </div>
                )}
                {'language' in feature && (
                  <div className="grid grid-cols-[140px_1fr] items-center gap-4">
                    <span className="text-sm font-medium">{t('Language')}</span>
                    <Input
                      className="w-40"
                      value={feature.language}
                      onChange={(event) => setFeature(key, { language: event.target.value })}
                    />
                  </div>
                )}
                <textarea
                  className="min-h-28 w-full rounded-md border bg-transparent p-2 text-sm"
                  value={feature.prompt || defaults[key].prompt}
                  onChange={(event) => setFeature(key, { prompt: event.target.value })}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
