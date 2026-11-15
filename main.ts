// Entry lifecycle: this process is the bridge between the trial env and the
// forge server built by app.ts. It starts the server on an ephemeral port,
// tells the env where to reach it, then waits until the env declares the
// trial finished.
//
//   1. MAKEFUN_ENV_URL must name the env origin (http://store:8080 in a trial).
//      With no value there is nothing to register with, so exit 1 at once.
//   2. Listen on port 0 and let the kernel choose. Never bind 8080: the env
//      owns it.
//   3. POST /register with {"port": N}. The env records the caller plus N as
//      the base URL. 200 is success; 409 means some other entry registered
//      first, and this process simply waits like any other.
//   4. Poll GET /done until the body reads {"done": true}. The env answers at
//      once ({"done": false} while the suite runs), so poll, never hold a
//      request open. Failed or slow polls retry with a short exponential
//      backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness stops the env afterwards, and
//      the env writes the export the scorer reads.
//
// This file imports only the server factory from app.ts: no packages, no Node
// built-ins, no model calls.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may run before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest wait. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_FIRST_MS, capped. */
function retryDelay(attempt: number): number {
  const exponent = Math.min(attempt, 8);
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** exponent);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or another
 * status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
