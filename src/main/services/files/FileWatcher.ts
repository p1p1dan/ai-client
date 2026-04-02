import { createRequire } from 'node:module';
import type { AsyncSubscription, Event } from '@parcel/watcher';

// @parcel/watcher is CJS with native addon; use createRequire to bypass ESM linker in ASAR
const { subscribe } = createRequire(import.meta.url)('@parcel/watcher') as {
  subscribe: typeof import('@parcel/watcher')['subscribe'];
};

export type FileChangeCallback = (type: 'create' | 'update' | 'delete', path: string) => void;

export class FileWatcher {
  private subscription: AsyncSubscription | null = null;
  private dirPath: string;
  private callback: FileChangeCallback;

  constructor(dirPath: string, callback: FileChangeCallback) {
    this.dirPath = dirPath;
    this.callback = callback;
  }

  async start(): Promise<void> {
    this.subscription = await subscribe(
      this.dirPath,
      (err: Error | null, events: Event[]) => {
        if (err) {
          console.error('File watcher error:', err);
          return;
        }

        for (const event of events) {
          this.callback(event.type, event.path);
        }
      },
      {
        ignore: ['node_modules', '.git', 'dist', 'out'],
        // Use native backend to avoid watchman dependency
        backend: process.platform === 'win32' ? 'windows' : undefined,
      }
    );
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
  }
}
