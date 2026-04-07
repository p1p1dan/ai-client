import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export const runtimeNativePackages = ['node-pty', 'sqlite3'] as const;

// On Windows, TEC Solutions OCular Agent encrypts .js files written by Node.js.
// This plugin rewrites output files via a .bin intermediate + PowerShell copy
// to produce unencrypted files that Electron can load.
function winTsdFixPlugin(outSubDir: string) {
  if (process.platform !== 'win32') return null;
  return {
    name: 'win-tsd-fix',
    enforce: 'post' as const,
    closeBundle() {
      const outDir = path.resolve(__dirname, 'out', outSubDir);
      if (!fs.existsSync(outDir)) return;
      const exts = new Set(['.js', '.cjs', '.mjs', '.css', '.html']);
      const files: string[] = [];
      function collect(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) collect(full);
          else if (exts.has(path.extname(e.name))) files.push(full);
        }
      }
      collect(outDir);
      if (files.length === 0) return;
      // Write decoded content to .tmp.bin (node.js reads TSD transparently)
      for (const f of files) {
        fs.writeFileSync(f + '.tmp.bin', fs.readFileSync(f));
      }
      // PowerShell copies .tmp.bin -> original path (unencrypted result)
      const psScript =
        `Get-ChildItem '${outDir}' -Recurse -Filter '*.tmp.bin' | ` +
        `ForEach-Object { $t=$_.FullName -replace '\\.tmp\\.bin$',''; ` +
        `[System.IO.File]::Copy($_.FullName,$t,$true); Remove-Item $_.FullName -Force }`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [winTsdFixPlugin('main')],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: [...runtimeNativePackages],
      },
    },
  },
  preload: {
    plugins: [winTsdFixPlugin('preload')],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), winTsdFixPlugin('renderer')],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
