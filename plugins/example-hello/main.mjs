// @ts-check
/**
 * Example PiLab plugin: counts the chat events it sees and shows the count on
 * the Plugins page. See docs/plugins/developing-plugins.md.
 *
 * @typedef {import('../../src/shared/plugins/api.ts').PilabPluginApi} PilabPluginApi
 */

/** @param {PilabPluginApi} pilab */
export function activate(pilab) {
  let count = 0;
  /** @type {(() => void) | undefined} */
  let unsubscribe;

  const show = async () => {
    const { label } = await pilab.settings.get();
    await pilab.status.set({ state: 'ok', text: `${label}: ${count} 个对话事件` });
  };

  pilab.services.register('counter', {
    start: async () => {
      unsubscribe = pilab.chat.onEvent(() => {
        count += 1;
        void show();
      });
      await show();
    },
    stop: () => {
      unsubscribe?.();
    },
  });

  pilab.settings.onChange(() => void show());
  pilab.log.info('example plugin activated');
}
