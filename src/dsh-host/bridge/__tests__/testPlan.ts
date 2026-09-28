/**
 * The model plan the bridge's unit tests run with (P1-5a, decision 033): the
 * probes' fake route, plus a reasoning model on a second route for the
 * per-turn routing tests.
 */

import type { DshBridgeModelPlan } from '../modelRoute.ts';

export const TEST_PLAN: DshBridgeModelPlan = {
  revision: 'test-plan',
  defaultModel: { provider: 'aiclient-gateway', model: 'fake-1' },
  index: {
    'aiclient-gateway/fake-1': {
      route: 'aiclient-gateway',
      model: 'fake-1',
      efforts: [],
      image: false,
    },
    'thinker/deep-1': {
      route: 'thinker~2',
      model: 'deep-1',
      efforts: ['low', 'medium', 'high'],
      image: true,
    },
  },
};
