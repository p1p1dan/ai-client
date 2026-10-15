# http-retry

Retries a failing HTTP call with exponential backoff.

```js
import { withRetry } from './src/retry.js';

const body = await withRetry(() => fetchJson('/api/items'));
```
