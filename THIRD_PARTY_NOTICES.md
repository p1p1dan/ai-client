# Third-Party Notices

AiClient is distributed under the MIT License. See `LICENSE` for the AiClient
copyright and license terms.

This file records third-party source incorporated into AiClient and core
third-party components distributed with the application. Dependency packages
may also contain their own copyright and license notices; those notices remain
applicable.

## pi-app

Source: https://github.com/justhil/pi-app

AiClient includes adapted behavior and a reference test derived from pi-app,
including the streaming Markdown comparison in
`src/renderer/components/chat/__tests__/piMarkdownSplitComparison.test.ts`.

MIT License

Copyright (c) 2026 justhil

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pix

Source: https://github.com/num-scope/pix

AiClient includes adapted source from pix, notably:

- `src/main/services/terminal/piTuiSession.ts`

MIT License

Copyright (c) 2026 Num Scope

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pi coding agent

Package: `@earendil-works/pi-coding-agent` 0.84.3

Source: https://github.com/earendil-works/pi

The Pi coding agent and its Pi packages are distributed under the MIT License.
The npm package manifest identifies Mario Zechner as the author. AiClient
bundles the Pi SDK and CLI as its conversation runtime.

`src/shared/legacyPiSession/context.ts` contains a vendored subset of
`buildSessionContext` from `@earendil-works/pi-agent-core` 0.84.4
(`dist/harness/session/context.js` and `dist/harness/messages.js`), used to read
Pi session files without the package; it carries the notice below.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Other bundled dependencies

AiClient also distributes third-party npm dependencies declared by the root
`package.json`, `src/agent-host/package-lock.json` and
`src/dsh-host/package-lock.json`. Their package metadata and source
repositories remain the authority for their respective copyright holders and
license terms. The packaged Pi worker and the packaged DeepSeek Harness host
preserve license files provided by their dependency packages; this consolidated
notice supplements packages whose published archive does not include a
standalone license file.

## DeepSeek Harness host

Source: https://github.com/deepseek-ai/deepseek-harness (packages
`@deepseek-ai/dsh-*` 0.1.7-rc.2 and their dependencies, from
`src/dsh-host/package-lock.json`).

AiClient ships the DeepSeek Harness (DSH) packages as its chat engine in
`resources/dsh-host`. Every installed package keeps its own license files
there, and `resources/dsh-host/THIRD_PARTY_LICENSES.json` lists each package of
that directory with its version, `license` field and license file paths.

The `@deepseek-ai/dsh-*` packages are distributed under the MIT License:

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The Cordis packages published as `@deepseek-ai/cordis*` (from the same
repository) carry their own notice:

MIT License

Copyright (c) 2021-present Shigma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Most other packages of the host are under the MIT, Apache-2.0 or ISC
licenses. The following are not, or need a note:

- **libvips and its dependencies** (`@img/sharp-libvips-<platform>`, and on
  Windows the DLLs inside `@img/sharp-win32-<arch>`), used by `sharp` to read
  images: libvips, glib, fribidi, libexif, libheif, librsvg, pango and
  proxy-libintl under the LGPL-3.0-or-later; cairo under the MPL-2.0; aom under
  the BSD 2-Clause license plus the Alliance for Open Media Patent License 1.0;
  the rest under MIT, BSD or zlib-style licenses. The package README (Linux,
  macOS) lists every library and its license, and `versions.json` records each
  version; both ship next to the libraries. The libraries are separate shared
  objects that can be replaced. Sources: https://github.com/lovell/sharp-libvips
  and the upstream projects it names.
- **`@deepseek-ai/node-addon-system`**: its `package.json` says BSD-3-Clause
  and its archive carries the DeepSeek MIT text above; its Linux packages carry
  a BSD 3-Clause License, "Copyright (c) 2026, node-addon-landlock-run
  contributors". Both texts are kept as published.
- BSD-3-Clause: protobufjs and `@protobufjs/*`, `diff`, `fast-uri`,
  `buffer-equal-constant-time`; BSD-2-Clause: `@mixmark-io/domino`;
  Python-2.0: `argparse`; Unlicense: `fast-sha256`; 0BSD: `tslib`;
  BlueOak-1.0.0: `chownr`, `isexe`, `minipass`, `tar` and `yallist` inside the
  `pnpm` package.
- **ConPTY** (`conpty.dll`, `OpenConsole.exe`, from Microsoft's Windows
  Terminal, MIT License, https://github.com/microsoft/terminal), shipped inside
  `node-pty` on Windows, both in `resources/dsh-host` and in the app's own
  `resources/node_modules/node-pty`.
- Packages whose published archive has no license file:
  `@aws-sdk/credential-provider-http`, `@aws-sdk/credential-provider-login`
  and `@aws-sdk/nested-clients` (Apache-2.0, https://github.com/aws/aws-sdk-js-v3);
  `@earendil-works/pi-ai` and `@earendil-works/pi-telemetry` (MIT,
  https://github.com/earendil-works/pi); `@koromix/koffi-<platform>` (MIT, the
  `koffi` license, https://github.com/Koromix/koffi); `data-uri-to-buffer`
  (MIT, https://github.com/TooTallNate/node-data-uri-to-buffer);
  `standardwebhooks` (MIT, https://github.com/standard-webhooks/standard-webhooks);
  `@reflink/reflink*` (MIT, https://github.com/pnpm/reflink) and the
  BlueOak-1.0.0 packages bundled in `pnpm`; and the libvips packages above,
  whose license terms are in their README.

## pi-permission-system runtime compatibility

Source: https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system

The native runtime adapts the Bash AST inspection approach, policy scope order,
and wildcard matching semantics. Files: `src/runtime/plugins/permissions/`.
The old permission extension itself is not imported by the native runtime.

MIT License

Copyright (c) 2026 MasuRii and Christopher D. Lasher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
