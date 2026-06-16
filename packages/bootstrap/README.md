# JYW Bootstrapper

`jyw-bootstrap` is the v0 native launcher for the unified AI client wedge test.

It logs in to the company SaaS, fetches a short-lived group key, writes an isolated Claude Code config, writes a one-time DeepChat provider payload file, and launches either Code or Chat mode.

## Current Scope

- `--mode code` writes `CLAUDE_CONFIG_DIR=<tempdir>/settings.json` and launches `ai-client`.
- `--mode chat` writes `%TEMP%/jyw-ai-client/deepchat-provider-install/<nonce>.json` and launches DeepChat with `deepchat://provider/install?v=1&from=file&nonce=<nonce>`.
- `sessionToken` is held in process memory only.
- `baseUrl` is rejected unless its host matches `JYW_BOOTSTRAP_ALLOWED_BASE_URL_SUFFIXES`.
- Account/password fallback is implemented for v0 CLI validation; OAuth UI remains the next slice.

## Build

```powershell
go test ./...
go build -trimpath -ldflags="-s -w" -o dist/jyw-bootstrap.exe ./cmd/jyw-bootstrap
```

The current Codex environment does not have Go installed, so build validation must run on a machine with Go.

## Required Runtime Configuration

```powershell
$env:JYW_BOOTSTRAP_SERVER_URL = "https://ai-gateway.example.com"
$env:JYW_BOOTSTRAP_GROUP_ID = "default"
$env:JYW_BOOTSTRAP_USERNAME = "<user>"
$env:JYW_BOOTSTRAP_PASSWORD = "<password>"
$env:JYW_BOOTSTRAP_ALLOWED_BASE_URL_SUFFIXES = "jyw.example.com,.jyw.example.com"
$env:JYW_BOOTSTRAP_CODE_PATH = "C:\Program Files\JywAiClient\ai-client\jyw-ai-client.exe"
$env:JYW_BOOTSTRAP_CHAT_PATH = "C:\Program Files\JywAiClient\deepchat\DeepChat.exe"
```

Endpoint defaults are `/auth/login` and `/groups/{groupId}/keys`. Override with `JYW_BOOTSTRAP_LOGIN_PATH` and `JYW_BOOTSTRAP_KEYS_PATH_TEMPLATE` if the SaaS keeps the `/api` prefix.

## Vendor Runbook

DeepChat is patched as a local fork. Vendor it into this repo with a submodule or subtree before packaging:

```powershell
git submodule add <deepchat-fork-url> vendor/deepchat
```

For a subtree workflow, import the fork into `vendor/deepchat` and keep the patch limited to `src/main/presenter/deeplinkPresenter/index.ts` plus related tests/docs. On every upstream upgrade, re-run the provider deeplink tests and verify `from=file&nonce=` still deletes the payload file after import.
