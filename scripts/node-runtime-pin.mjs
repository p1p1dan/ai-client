/** Pinned Node runtime bundled into the packaged app (C-15 / D17). */
export const NODE_RUNTIME_PIN = {
  version: '24.18.0',
  platform: 'win-x64',
  zipName: 'node-v24.18.0-win-x64.zip',
  /** SHA-256 of the official zip (nodejs.org SHASUMS256.txt). */
  zipSha256: '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
  urls: [
    'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip',
    'https://registry.npmmirror.com/-/binary/node/v24.18.0/node-v24.18.0-win-x64.zip',
  ],
};
