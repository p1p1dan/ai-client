declare const __ONBOARDING_SERVICE_URL__: string;

// Test-only login bypass credentials, injected at build time from env vars.
// Empty string in any normal/release build (see electron.vite.config.ts).
declare const __TEST_CLAUDE_BASE_URL__: string;
declare const __TEST_CLAUDE_TOKEN__: string;
declare const __TEST_CODEX_BASE_URL__: string;
declare const __TEST_CODEX_KEY__: string;
