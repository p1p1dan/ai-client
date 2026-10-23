/**
 * `node pilab-relay.mjs [--host 0.0.0.0] [--port 8790] [--data <dir>]
 *                       [--tls-cert cert.pem --tls-key key.pem] [--allow-http]`
 *
 * First start writes `<data>/relay.json` with a login password (for the phone)
 * and an access token (for each PiLab's settings) and prints both; later starts
 * print them again. Serving plain HTTP on a non-loopback address needs
 * `--allow-http`: the password and every conversation would cross the network
 * unencrypted.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRelayConfig, type RelayAsset, type RelayConfig, startRelay } from './server.ts';

declare const __RELAY_ASSETS__: Record<string, RelayAsset> | undefined;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function loadAssets(): Record<string, RelayAsset> {
  if (typeof __RELAY_ASSETS__ !== 'undefined') return __RELAY_ASSETS__;
  // Running from source: read the page next to this file.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  const assets: Record<string, RelayAsset> = {};
  for (const name of readdirSync(dir)) {
    assets[name] = {
      type: TYPES[path.extname(name)] ?? 'application/octet-stream',
      body: readFileSync(path.join(dir, name)),
    };
  }
  return assets;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const flag = (name: string) => process.argv.includes(`--${name}`);

if (flag('help') || flag('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const host = arg('host') ?? '0.0.0.0';
const port = Number(arg('port') ?? 8790);
const dataDir = arg('data') ?? path.join(homedir(), '.pilab-relay');
const certFile = arg('tls-cert');
const keyFile = arg('tls-key');
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

if ((certFile && !keyFile) || (!certFile && keyFile)) {
  console.error('--tls-cert 和 --tls-key 要一起给');
  process.exit(2);
}
if (!certFile && !loopback && !flag('allow-http')) {
  console.error(
    [
      `要在 ${host} 上对外提供服务，需要 HTTPS 证书：--tls-cert cert.pem --tls-key key.pem`,
      '只在内网或测试时用明文 HTTP，可以加 --allow-http（登录口令和对话内容会以明文经过网络）。',
      '只在本机用：--host 127.0.0.1',
    ].join('\n')
  );
  process.exit(2);
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configFile = path.join(dataDir, 'relay.json');
let config: RelayConfig;
if (existsSync(configFile)) {
  config = JSON.parse(readFileSync(configFile, 'utf8')) as RelayConfig;
} else {
  config = generateRelayConfig();
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const relay = await startRelay({
  host,
  port,
  config,
  assets: loadAssets(),
  ...(certFile && keyFile
    ? { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } }
    : {}),
});

const scheme = certFile ? 'https' : 'http';
const addresses = loopback
  ? [host === '::1' ? '[::1]' : '127.0.0.1']
  : Object.values(networkInterfaces())
      .flat()
      .filter((item) => item && item.family === 'IPv4' && !item.internal)
      .map((item) => item?.address ?? '');
console.log('');
console.log('PiLab 中转服务已启动');
for (const address of addresses)
  console.log(`  手机 / 浏览器打开：${scheme}://${address}:${relay.port}`);
console.log(`  登录口令：${config.loginPassword}`);
console.log(`  接入口令（填到每台 PiLab 的「手机远程」插件设置里）：${config.accessToken}`);
console.log(`  中转地址（填到插件设置里）：${scheme}://<这台服务器的 IP>:${relay.port}`);
console.log(`  口令保存在：${configFile}`);
if (!certFile && !loopback) console.log('  注意：正在用明文 HTTP');
console.log('');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
