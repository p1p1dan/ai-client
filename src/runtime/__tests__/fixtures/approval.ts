import type { PermissionConfig } from '../../plugins/permissions/index.ts';

/**
 * decision 012 — `permissions.approve` is required whenever `tools` is set.
 *
 * The Extension UI bridge used to stand in as a fallback approver, so a suite
 * could leave `approve` out and still build a runtime; `bootstrap` now refuses
 * that, because a runtime with a gate and no way to answer it only fails at the
 * first ask, mid-turn, as an opaque tool denial.
 *
 * A suite that does not MEAN to be asked passes this: being asked is then a
 * loud test failure rather than a silent denial. A suite that does mean to be
 * asked passes its own `approve`.
 */
export const neverAsked: NonNullable<PermissionConfig['approve']> = (request) => {
  throw new Error(`unexpected permission request for ${request.tool}`);
};

/**
 * The opposite default, for a suite whose subject IS the gate: every ask is
 * refused, so "the tool call was denied" is evidence that it reached the gate
 * rather than evidence that nobody was listening.
 */
export const alwaysDenied: NonNullable<PermissionConfig['approve']> = async () => 'deny';
