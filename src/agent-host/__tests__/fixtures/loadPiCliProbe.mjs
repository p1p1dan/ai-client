/**
 * P6-2/P6-5 control: a process that really does load pi-coding-agent.
 *
 * Exists so `nativeWorkerModuleLoads.test.ts` can prove its recorder reports a
 * load when one happens. The deep path rather than the package entry: that
 * entry pulls in the TUI module graph, which does not link against the pi-tui
 * version installed here — and what is being proven is that the recorder sees
 * the specifier, not that the whole CLI boots.
 */
await import('@earendil-works/pi-coding-agent/dist/core/session-manager.js').catch(() => {});
