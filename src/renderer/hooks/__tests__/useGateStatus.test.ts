import { describe, expect, it } from 'vitest';
import { deriveGateStatus, type GateInputs } from '../useGateStatus';
import type { ClaudeRuntimeStatus } from '@shared/types';

describe('deriveGateStatus', () => {
  // Helper to build baseline inputs with all required fields
  const baseInputs: GateInputs = {
    onboardingData: { registered: true },
    runtimeStatus: { kind: 'node-compatible', cliVersion: '2.1.112' },
    runtimeRetrying: false,
    cliData: { claudeInstalled: true },
    credentialsData: { claudeEnvOk: true, codexAuthOk: true },
    registered: true,
  };

  describe('happy path', () => {
    it('returns ready when all gates pass', () => {
      const result = deriveGateStatus(baseInputs);
      expect(result.stage).toBe('ready');
      if (result.stage === 'ready') {
        expect(result.runtimeStatus.kind).toBe('node-compatible');
      }
    });
  });

  describe('loading states', () => {
    it('returns loading when onboardingData is undefined', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        onboardingData: undefined,
      });
      expect(result.stage).toBe('loading');
    });

    it('returns loading when runtimeStatus is null', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        runtimeStatus: null,
      });
      expect(result.stage).toBe('loading');
    });

    it('returns loading when registered but cliData is undefined', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: undefined,
      });
      expect(result.stage).toBe('loading');
    });

    it('returns loading when claudeInstalled but credentialsData is undefined', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: true },
        credentialsData: undefined,
      });
      expect(result.stage).toBe('loading');
    });

    it('does NOT return loading when data exists but background refetch is active', () => {
      // Anti-jitter: runtimeRetrying=true (isFetching) but runtimeStatus has
      // stable data — should stay at current stage, not regress to loading.
      const result = deriveGateStatus({
        ...baseInputs,
        runtimeRetrying: true,
      });
      expect(result.stage).toBe('ready');
    });
  });

  describe('runtime-failed', () => {
    it('returns runtime-failed when detection-failed', () => {
      const failedStatus: ClaudeRuntimeStatus = {
        kind: 'detection-failed',
        error: 'IPC timeout',
      };
      const result = deriveGateStatus({
        ...baseInputs,
        runtimeStatus: failedStatus,
        runtimeRetrying: false,
      });
      expect(result.stage).toBe('runtime-failed');
      if (result.stage === 'runtime-failed') {
        expect(result.error).toBe('IPC timeout');
        expect(result.retrying).toBe(false);
      }
    });

    it('returns runtime-failed with retrying=true when runtime is refetching', () => {
      const failedStatus: ClaudeRuntimeStatus = {
        kind: 'detection-failed',
        error: 'probe crash',
      };
      const result = deriveGateStatus({
        ...baseInputs,
        runtimeStatus: failedStatus,
        runtimeRetrying: true,
      });
      expect(result.stage).toBe('runtime-failed');
      if (result.stage === 'runtime-failed') {
        expect(result.retrying).toBe(true);
      }
    });
  });

  describe('vscode-extension-only folds into cli-missing', () => {
    it('unregistered vscode-extension-only user enters register (register-first)', () => {
      const vscodeStatus: ClaudeRuntimeStatus = {
        kind: 'vscode-extension-only',
        vscodeExtension: { path: '/vscode/ext', version: '1.2.3' },
      };
      const result = deriveGateStatus({
        ...baseInputs,
        onboardingData: { registered: false },
        registered: false,
        runtimeStatus: vscodeStatus,
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('register');
      }
    });

    it('registered vscode-extension-only user is cli-missing with vscodeExtension tag', () => {
      const vscodeStatus: ClaudeRuntimeStatus = {
        kind: 'vscode-extension-only',
        vscodeExtension: { path: '/vscode/ext', version: '1.2.3' },
      };
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        // CLI reports installed=false too, but the point is: even the vscode
        // signal alone routes to cli-missing and carries the extension info.
        cliData: { claudeInstalled: false },
        runtimeStatus: vscodeStatus,
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('cli-missing');
        expect(result.vscodeExtension).toEqual({ path: '/vscode/ext', version: '1.2.3' });
      }
    });
  });

  describe('onboarding variants', () => {
    it('returns onboarding/register when not registered', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        onboardingData: { registered: false },
        registered: false,
        runtimeStatus: { kind: 'not-installed' },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('register');
      }
    });

    it('returns onboarding/cli-missing when registered but CLI not installed', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: false },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('cli-missing');
      }
    });

    it('registered + runtime not-installed folds into cli-missing (no vscode tag)', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: false },
        runtimeStatus: { kind: 'not-installed' },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('cli-missing');
        expect(result.vscodeExtension).toBeUndefined();
      }
    });

    it('returns onboarding/credentials-unhealthy when claudeEnvOk is false', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: true },
        credentialsData: { claudeEnvOk: false, codexAuthOk: true },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('credentials-unhealthy');
      }
    });

    it('returns onboarding/credentials-unhealthy when codexAuthOk is false', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: true },
        credentialsData: { claudeEnvOk: true, codexAuthOk: false },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('credentials-unhealthy');
      }
    });

    it('returns onboarding/credentials-unhealthy when both credentials are unhealthy', () => {
      const result = deriveGateStatus({
        ...baseInputs,
        registered: true,
        cliData: { claudeInstalled: true },
        credentialsData: { claudeEnvOk: false, codexAuthOk: false },
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('credentials-unhealthy');
      }
    });
  });

  describe('decision tree precedence', () => {
    it('runtime-failed takes precedence over unregistered', () => {
      const failedStatus: ClaudeRuntimeStatus = {
        kind: 'detection-failed',
        error: 'PATH lookup failed',
      };
      const result = deriveGateStatus({
        ...baseInputs,
        onboardingData: { registered: false },
        registered: false,
        runtimeStatus: failedStatus,
      });
      expect(result.stage).toBe('runtime-failed');
    });

    it('register takes precedence over runtime kind (register-first)', () => {
      // Unregistered users always enter the register flow, even when the runtime
      // is vscode-extension-only — registration is the mandatory trunk.
      const vscodeStatus: ClaudeRuntimeStatus = {
        kind: 'vscode-extension-only',
        vscodeExtension: { path: '/vscode', version: '1.0.0' },
      };
      const result = deriveGateStatus({
        ...baseInputs,
        onboardingData: { registered: false },
        registered: false,
        runtimeStatus: vscodeStatus,
      });
      expect(result.stage).toBe('onboarding');
      if (result.stage === 'onboarding') {
        expect(result.variant).toBe('register');
      }
    });
  });

  describe('bun-incompatible', () => {
    it('returns ready when runtime is bun-incompatible (gate passes, banner handles it)', () => {
      const bunStatus: ClaudeRuntimeStatus = {
        kind: 'bun-incompatible',
        cliVersion: '2.1.115',
      };
      const result = deriveGateStatus({
        ...baseInputs,
        runtimeStatus: bunStatus,
      });
      expect(result.stage).toBe('ready');
      if (result.stage === 'ready') {
        expect(result.runtimeStatus.kind).toBe('bun-incompatible');
      }
    });
  });
});
