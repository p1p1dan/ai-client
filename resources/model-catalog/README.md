# Bundled model catalog snapshot (A3)

`snapshot.json` is the model catalog that ships **inside the release artifact**.
It is the offline floor beneath `/api/v1/models-config`: since plan D03 removed the
built-in model table, a first launch, a weak network or a management endpoint that is
down all leave the user with an empty model menu and no way to run anything.

## What reads it

`src/main/services/piModelConfig/catalogSnapshot.ts`, with **no network I/O**, at the
point where `PiModelConfigService` would otherwise report `unavailable`.
The sync state then says `source: 'bundled'`, which is what lets the UI state that this
is the baseline the build shipped with rather than a fresh answer.

## What writes it

**Only `scripts/refresh-model-catalog.mjs`, at release time.** Nothing in the running
application ever writes this file, and nothing copies it into the user's data directory.
That rule is ADR 0134 §3: a per-machine cache would let two installs of one release run
different configurations, and the release artifact would stop being reproducible.

```bash
node scripts/refresh-model-catalog.mjs --api-key <client key>
```

The script fetches the endpoint, validates the body with the same validator the client
uses, and atomically replaces this file. Run it before tagging a release and include the
result in the release commit.

## Rules this file must satisfy

- **No credentials.** It is world-readable inside the package, so the reader validates it
  with `credentialsAllowed: false` and rejects any provider carrying an `apiKey`. Every
  provider must inherit its key (`credentials.apiKey: "onboarding"`).
- **A snapshot with zero models counts as no snapshot.** The reader returns `null` for it
  and the client stays `unavailable`, because `bundled` with an empty menu would be
  indistinguishable from a management endpoint that answered and had nothing enabled.

## Current contents

Empty (`providers: {}`), which is deliberately inert: the management endpoint is not
deployed yet, so there is no real catalog to snapshot. The mechanism, the packaging entry
and the refresh script are in place, and the first real baseline arrives the first time
the script is run against a deployed endpoint.
