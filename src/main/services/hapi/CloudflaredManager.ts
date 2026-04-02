import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Tunnel as TunnelClass } from 'cloudflared';

// cloudflared is CJS; use createRequire to bypass ESM linker in ASAR
const { install, use, Tunnel } = createRequire(import.meta.url)(
  'cloudflared'
) as typeof import('cloudflared');

import { app } from 'electron';
import { killProcessTree } from '../../utils/processUtils';

const execFileAsync = promisify(execFile);

// Use custom bin path in user data directory (asar is read-only)
const cloudflaredBin = path.join(
  app.getPath('userData'),
  'bin',
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
);

// Set the custom bin path
use(cloudflaredBin);

export interface CloudflaredStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  url?: string;
  error?: string;
}

export type TunnelMode = 'quick' | 'auth';

export interface CloudflaredConfig {
  mode: TunnelMode;
  port: number;
  // Auth tunnel config
  token?: string;
  // Protocol: http2 (more compatible) or quic (default cloudflared)
  protocol?: 'http2' | 'quic';
}

class CloudflaredManager extends EventEmitter {
  private tunnel: TunnelClass | null = null;
  private status: CloudflaredStatus = { installed: false, running: false };

  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    if (!fs.existsSync(cloudflaredBin)) {
      return { installed: false };
    }

    try {
      const { stdout } = await execFileAsync(cloudflaredBin, ['--version']);
      const version = stdout.trim().split(' ')[2] || stdout.trim();
      this.status.installed = true;
      this.status.version = version;
      return { installed: true, version };
    } catch {
      return { installed: false };
    }
  }

  async install(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      // Ensure bin directory exists
      const binDir = path.dirname(cloudflaredBin);
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      await install(cloudflaredBin);
      const result = await this.checkInstalled();
      this.emit('statusChanged', this.getStatus());
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { installed: false, error: errorMsg };
    }
  }

  async start(config: CloudflaredConfig): Promise<CloudflaredStatus> {
    if (this.tunnel) {
      return this.status;
    }

    const check = await this.checkInstalled();
    if (!check.installed) {
      this.status = { installed: false, running: false, error: 'Cloudflared not installed' };
      this.emit('statusChanged', this.status);
      return this.status;
    }

    try {
      const localUrl = `http://localhost:${config.port}`;
      console.log('[cloudflared] Starting tunnel to:', localUrl);

      // Build options with protocol if specified
      const options: Record<string, string> = {};
      if (config.protocol) {
        options['--protocol'] = config.protocol;
      }

      // Create tunnel based on mode
      if (config.mode === 'quick') {
        console.log('[cloudflared] Quick tunnel mode, options:', options);
        this.tunnel = Tunnel.quick(localUrl, options);
      } else if (config.mode === 'auth' && config.token) {
        console.log('[cloudflared] Auth tunnel mode');
        this.tunnel = Tunnel.withToken(config.token, options);
      } else {
        this.status = {
          installed: true,
          version: check.version,
          running: false,
          error: 'Invalid tunnel configuration',
        };
        this.emit('statusChanged', this.status);
        return this.status;
      }

      // Listen for tunnel URL (quick tunnel)
      this.tunnel.on('url', (url: string) => {
        console.log('[cloudflared] Tunnel URL:', url);
        this.status = {
          installed: true,
          version: check.version,
          running: true,
          url,
        };
        this.emit('statusChanged', this.status);
      });

      // Listen for connection events (auth tunnel)
      this.tunnel.on('connected', (connection: { id: string; ip: string; location: string }) => {
        console.log('[cloudflared] Connected:', connection);
        // For auth tunnel, mark as running when connected
        if (config.mode === 'auth' && !this.status.url) {
          this.status = {
            installed: true,
            version: check.version,
            running: true,
            url: 'Connected', // Auth tunnel URL is pre-configured
          };
          this.emit('statusChanged', this.status);
        }
      });

      this.tunnel.on('disconnected', (connection: { id: string; ip: string; location: string }) => {
        console.log('[cloudflared] Disconnected:', connection);
      });

      this.tunnel.on('stdout', (data: string) => {
        console.log('[cloudflared]', data);
      });

      this.tunnel.on('stderr', (data: string) => {
        console.error('[cloudflared]', data);
      });

      this.tunnel.on('error', (error: Error) => {
        console.error('[cloudflared] Error:', error.message);
        this.status = {
          installed: true,
          version: check.version,
          running: false,
          error: error.message,
        };
        this.tunnel = null;
        this.emit('statusChanged', this.status);
      });

      this.tunnel.on('exit', (code: number | null, signal: string | null) => {
        console.log('[cloudflared] Exit code:', code, 'signal:', signal);
        this.status = {
          installed: true,
          version: check.version,
          running: false,
          error: code !== null && code !== 0 ? `Process exited with code ${code}` : undefined,
        };
        this.tunnel = null;
        this.emit('statusChanged', this.status);
      });

      // Set initial running status
      this.status = {
        installed: true,
        version: check.version,
        running: true,
      };
      this.emit('statusChanged', this.status);

      return this.status;
    } catch (error) {
      this.status = {
        installed: true,
        version: check.version,
        running: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit('statusChanged', this.status);
      return this.status;
    }
  }

  async stop(): Promise<CloudflaredStatus> {
    this.killTunnel();

    const check = await this.checkInstalled();
    this.status = {
      installed: check.installed,
      version: check.version,
      running: false,
    };
    this.emit('statusChanged', this.status);
    return this.status;
  }

  getStatus(): CloudflaredStatus {
    return this.status;
  }

  cleanup(): void {
    this.killTunnel();
  }

  private killTunnel(): void {
    if (!this.tunnel) return;

    // Access the underlying child process for proper tree kill
    const proc = (this.tunnel as { process?: { pid?: number } }).process;
    if (proc?.pid) {
      killProcessTree(proc.pid);
    } else {
      this.tunnel.stop();
    }
    this.tunnel = null;
  }
}

export const cloudflaredManager = new CloudflaredManager();
