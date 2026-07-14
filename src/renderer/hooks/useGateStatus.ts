import type { ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const ONBOARDING_OPEN_EVENT = 'aiclient:onboarding:open';

// Gate stage discriminated union — decision tree order defines bedrock precedence
export type GateStatus =
  | { stage: 'loading' }
  | { stage: 'runtime-failed'; error?: string; retrying: boolean }
  | {
      stage: 'onboarding';
      variant: 'register' | 'cli-missing' | 'credentials-unhealthy';
      // Populated only for cli-missing when the machine has the VSCode Claude
      // extension. The completion screen uses it to add a "you can return to
      // VSCode" hint — the extension reads the same ~/.claude credentials.
      vscodeExtension?: VsCodeExtensionInfo;
    }
  | { stage: 'ready'; runtimeStatus: ClaudeRuntimeStatus };

export interface GateInputs {
  onboardingData: { registered?: boolean } | undefined;
  runtimeStatus: ClaudeRuntimeStatus | null;
  runtimeRetrying: boolean;
  cliData: { claudeInstalled: boolean } | undefined;
  credentialsData: { claudeEnvOk: boolean; codexAuthOk: boolean } | undefined;
  registered: boolean;
}

/**
 * Pure decision tree: maps 4 query states + runtime override into a single gate stage.
 * Anti-jitter design: uses `data === undefined` (never succeeded) instead of `isLoading`
 * so background refetch (isFetching=true but data present) does not regress to loading.
 */
export function deriveGateStatus(inputs: GateInputs): GateStatus {
  const {
    onboardingData,
    runtimeStatus,
    runtimeRetrying,
    cliData,
    credentialsData,
    registered,
  } = inputs;

  // 1. Onboarding never loaded, or runtime never resolved (null = no override, no
  // data, no error). runtimeStatus already folds override/data/error, so null means
  // genuinely never succeeded. Using null (not isLoading) is the anti-jitter core:
  // background refetch keeps stable data, so runtimeStatus stays non-null.
  if (onboardingData === undefined || runtimeStatus === null) {
    return { stage: 'loading' };
  }

  // 2. Runtime detection failed for non-CLI reason (IPC crash, fs permission, etc.)
  if (runtimeStatus.kind === 'detection-failed') {
    return { stage: 'runtime-failed', error: runtimeStatus.error, retrying: runtimeRetrying };
  }

  // 3. Register-first: registration + writing credentials is the mandatory trunk
  // every user walks. Whether the CLI exists (and thus whether AiClient itself can
  // run) is a downstream, optional concern surfaced AFTER registration. So an
  // unregistered user always enters the register flow, regardless of runtime kind —
  // including vscode-extension-only, which used to short-circuit to a dedicated shell.
  if (!registered) {
    return { stage: 'onboarding', variant: 'register' };
  }

  // 4. Registered but CLI status never loaded (first enable after onboarding flip)
  if (cliData === undefined) {
    return { stage: 'loading' };
  }

  // 5. CLI presence is the single question runtime kind answers: node-compatible and
  // bun-incompatible mean "CLI present" (bun gets a downgrade banner at 'ready');
  // vscode-extension-only and not-installed mean "CLI missing". We route both missing
  // cases to the same cli-missing branch, tagging vscodeExtension so the completion
  // screen can add a "return to VSCode" hint.
  const cliMissing =
    !cliData.claudeInstalled ||
    runtimeStatus.kind === 'vscode-extension-only' ||
    runtimeStatus.kind === 'not-installed';
  if (cliMissing) {
    return {
      stage: 'onboarding',
      variant: 'cli-missing',
      vscodeExtension:
        runtimeStatus.kind === 'vscode-extension-only'
          ? runtimeStatus.vscodeExtension
          : undefined,
    };
  }

  // 6. Registered + CLI present but credentials health never loaded
  if (credentialsData === undefined) {
    return { stage: 'loading' };
  }

  // 7. Registered + CLI present but credentials unhealthy (self-heal scenario)
  if (!credentialsData.claudeEnvOk || !credentialsData.codexAuthOk) {
    return { stage: 'onboarding', variant: 'credentials-unhealthy' };
  }

  // 8. All gates passed
  return { stage: 'ready', runtimeStatus };
}

export interface UseGateStatusReturn {
  gateStatus: GateStatus;
  queryClient: ReturnType<typeof useQueryClient>;
  runtime: ReturnType<typeof useQuery>;
  setRuntimeOverride: (status: ClaudeRuntimeStatus | null) => void;
  invalidateAll: () => void;
}

/**
 * Consolidates Root.tsx 4 independent queries into a single hook. Returns gate
 * status (loading / runtime-failed / onboarding / ready) plus all render
 * dependencies.
 */
export function useGateStatus(): UseGateStatusReturn {
  const queryClient = useQueryClient();

  const onboarding = useQuery({
    queryKey: ['onboardingState'],
    queryFn: async () => window.electronAPI.onboarding.check(),
    staleTime: 1000 * 60 * 5,
  });

  const registered = onboarding.data?.registered === true;

  const cliStatus = useQuery({
    queryKey: ['onboardingCliStatus'],
    queryFn: async () => window.electronAPI.onboarding.detectCli(),
    enabled: registered,
    staleTime: 1000 * 60,
  });

  const credentialsHealth = useQuery({
    queryKey: ['onboardingCredentialsHealth'],
    queryFn: async () => window.electronAPI.onboarding.checkCredentialsHealth(),
    enabled: registered,
    staleTime: 1000 * 30,
  });

  const runtime = useQuery({
    queryKey: ['claudeRuntimeStatus'],
    queryFn: async () => window.electronAPI.claudeRuntime.check(false),
    staleTime: 1000 * 30,
    retry: 1,
  });

  const [runtimeOverride, setRuntimeOverride] = useState<ClaudeRuntimeStatus | null>(null);

  // Assemble runtime status: override > last stable data > error-mapped detection-failed
  const runtimeStatus: ClaudeRuntimeStatus | null =
    runtimeOverride ??
    runtime.data ??
    (runtime.isError
      ? {
          kind: 'detection-failed',
          error: runtime.error instanceof Error ? runtime.error.message : String(runtime.error),
        }
      : null);

  // Node-compatible: disable Claude auto-updater so next launch doesn't pull Bun build
  useEffect(() => {
    if (runtimeStatus?.kind === 'node-compatible') {
      void window.electronAPI.claudeRuntime.disableAutoUpdates();
    }
  }, [runtimeStatus?.kind]);

  // ONBOARDING_OPEN_EVENT listener: invalidate all gate queries
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
      queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, handler);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handler);
  }, [queryClient]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
    queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
    queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
    queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
    queryClient.invalidateQueries({ queryKey: ['usageStats'] });
  };

  const gateStatus = deriveGateStatus({
    onboardingData: onboarding.data,
    runtimeStatus,
    runtimeRetrying: runtime.isFetching,
    cliData: cliStatus.data,
    credentialsData: credentialsHealth.data,
    registered,
  });

  return {
    gateStatus,
    queryClient,
    runtime,
    setRuntimeOverride,
    invalidateAll,
  };
}
