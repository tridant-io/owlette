const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Advisory header the api attaches during a free trial. */
const BILLING_WARNING_HEADER = 'x-owlette-billing-warning';

/** Latch so the trial advisory prints once per process, not once per request. */
let billingWarningPrinted = false;

/**
 * Print the trial-countdown advisory, at most once per process. No-op without the header, so
 * subscribed accounts stay silent. stderr, never stdout — `--json` must stay pipeable into `jq`.
 *
 * Called by {@link fetchWithTimeout}; exported for `chat` and `listen`, which use a bare `fetch`
 * because a 30s timeout signal would sever the stream.
 */
export function noteBillingWarning(response: { headers: Headers }): void {
  if (billingWarningPrinted) return;
  const warning = response.headers.get(BILLING_WARNING_HEADER);
  if (!warning) return;
  billingWarningPrinted = true;
  process.stderr.write(`owlette: ${warning}\n`);
}

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(input, { ...rest, signal });
    noteBillingWarning(response);
    return response;
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}

