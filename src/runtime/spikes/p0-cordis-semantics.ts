/**
 * P0 spike — pin down the Cordis v4 rc semantics the runtime bootstrap relies on.
 *
 * Three questions, none answerable from the package README (which is a stub):
 *   1. does `static inject` on a `Service` subclass defer activation until the
 *      dependency exists, rather than throwing?
 *   2. does the fiber returned by `ctx.plugin()` settle before its injects are
 *      satisfied? (bootstrap must not report "ready" on a half-wired graph)
 *   3. does disposing a fiber remove the service from the context?
 *
 * Throwaway probe, excluded from the type-check gate like `agent-host/spikes`.
 */
import { Context, Service } from 'cordis';

declare module 'cordis' {
  interface Context {
    greeter: Greeter;
    shouter: Shouter;
  }
}

class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter');
  }
  greet(name: string) {
    return `hello ${name}`;
  }
}

class Shouter extends Service {
  static inject = ['greeter'];
  constructor(ctx: Context) {
    super(ctx, 'shouter');
  }
  shout(name: string) {
    return this.ctx.greeter.greet(name).toUpperCase();
  }
}

const ctx = new Context();

// Q1/Q2: register the dependant FIRST.
const shouterFiber = await ctx.plugin(Shouter);
console.log('after dependant only — shouter present?', ctx.get('shouter') !== undefined);
console.log('  fiber state:', shouterFiber.state);

const greeterFiber = await ctx.plugin(Greeter);
// Cordis re-runs the deferred fiber asynchronously; wait for the graph to settle.
await shouterFiber.await();
console.log('after dependency arrives — shouter present?', ctx.get('shouter') !== undefined);
console.log('  shout:', ctx.get('shouter')?.shout('runtime'));

// Q3: disposing the dependency must retract the dependant too.
await greeterFiber.dispose();
console.log('after dependency disposed — greeter present?', ctx.get('greeter') !== undefined);
console.log('after dependency disposed — shouter present?', ctx.get('shouter') !== undefined);
