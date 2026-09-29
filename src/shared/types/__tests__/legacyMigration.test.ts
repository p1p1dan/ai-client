import { describe, expect, it } from 'vitest';
import { DSH_SEED_STAGES } from '../dshHostProtocol';
import {
  formatLegacyMigrationFailure,
  LEGACY_MIGRATION_MAIN_CODES,
  legacyConverterStamp,
  legacyRowKeyFor,
  parseLegacyMigrationFailure,
} from '../legacyMigration';

/** dsh-rebase P1-9d (decisions 051, 122): what Main and the renderer agree on. */
describe('legacy migration wire (P1-9d)', () => {
  it('formats a failure as `legacy_migration_failed:<stage>/<code>` and parses it back, through Electron’s wrapping', () => {
    for (const stage of [...DSH_SEED_STAGES, 'host', 'index'] as const) {
      for (const retryable of [true, false]) {
        const message = formatLegacyMigrationFailure('chat-1', {
          stage,
          code: 'some_code',
          retryable,
        });
        expect(
          message.startsWith(`legacy_migration_failed:${stage}/some_code: Session chat-1 `)
        ).toBe(true);
        expect(
          parseLegacyMigrationFailure(
            `Error invoking remote method 'chat:resumeSession': Error: ${message}`
          )
        ).toEqual({ stage, code: 'some_code', retryable });
      }
    }
  });

  it('never lets a code carry anything but a code', () => {
    const message = formatLegacyMigrationFailure('chat-1', {
      stage: 'read',
      code: '/home/someone/secret.jsonl',
      retryable: false,
    });
    expect(message).toMatch(/^legacy_migration_failed:read\/unknown: /);
    expect(message).not.toContain('/home/');
  });

  it('reads nothing into other errors', () => {
    expect(
      parseLegacyMigrationFailure('legacy_session_readonly: Session s1 is read-only')
    ).toBeNull();
    expect(parseLegacyMigrationFailure('legacy_migration_failed:nowhere/code: x')).toBeNull();
    expect(parseLegacyMigrationFailure('session_locked: held')).toBeNull();
  });

  it('keeps the legacy row under a deterministic key a DSH session id can be made of', () => {
    expect(legacyRowKeyFor('0f0e-uuid')).toBe('0f0e-uuid_pi');
    expect(legacyRowKeyFor(legacyRowKeyFor('a'))).toBe('a_pi_pi');
    // The bridge's projection-cache rule for DSH session ids (decision 121 rule 5).
    expect(`aiclient-${legacyRowKeyFor('3f2a9c1e-7d4b-4a8e-9b1c-2d3e4f5a6b7c')}`).toMatch(
      /^[A-Za-z0-9_-]+$/
    );
    expect(legacyConverterStamp(2)).toBe('pi-dsh/2');
  });

  it('Main’s codes are codes', () => {
    for (const code of Object.values(LEGACY_MIGRATION_MAIN_CODES)) {
      expect(code).toMatch(/^[a-z_]+$/);
    }
  });
});
