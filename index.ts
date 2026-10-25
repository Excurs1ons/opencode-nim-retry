/**
 * nim-retry — OpenCode V2 plugin.
 *
 * Works around NVIDIA NIM's rate limiting, which is hostile to both humans and
 * generic retry logic:
 *
 *   1. NIM returns 429 with the body `{"status":429,"title":"Too Many Requests"}`
 *      and NO `Retry-After` / `X-RateLimit-*` headers. OpenCode therefore falls
 *      back to its built-in exponential backoff, which is capped at 10s (session
 *      layer) / 30s (request layer) and at ~10 attempts -- i.e. roughly 1-2
 *      minutes in total. NIM's lockout is account-scoped and lasts minutes to
 *      hours, so the retries always exhaust and the 429 surfaces.
 *   2. NIM's limit is per account, not per key, and *keeps growing while you
 *      keep hammering it*. So long, patient waits beat fast retries.
 *   3. A 429 whose body happens to contain quota-ish wording is classified by
 *      OpenCode as `provider.quota` (QuotaExceeded), which is NOT retryable.
 *      This plugin force-retries every 429 from the target provider.
 *   4. Occasional `EAI_AGAIN` / other DNS-socket failures (`getaddrinfo`,
 *      `ENOTFOUND`, ...) are not in OpenCode's transport whitelist, so they can
 *      land on an unknown/unclassified failure. This plugin force-retries them
 *      with a short delay.
 *
 * IMPORTANT LIMITATION: a plugin cannot raise OpenCode's built-in maximum
 * attempt count ("The built-in maximum attempt count remains a hard limit").
 * The only lever a retry hook has is `{ retry, delay }`. This plugin therefore
 * spends the limited attempts on *long* waits for rate limits and *short* waits
 * for transient network blips.
 */
const DEFAULTS = {
  /** Only touch this provider (NIM). */
  providerId: "nvidia",
  /**
   * Delay schedule (ms) for 429 / rate-limit retries, indexed by attempt.
   * The last entry repeats. Deliberately long: NIM locks an account for
   * minutes and re-requesting extends the lock.
   */
  rateLimitDelays: [10_000, 30_000, 60_000, 120_000],
  /** Upper clamp for any delay we set (ms). */
  maxDelay: 300_000,
  /** Delay for transient network / DNS (EAI_*) failures (ms). */
  networkDelay: 2_000,
  /** Delay for 5xx / provider-internal failures (ms). */
  serverErrorDelay: 5_000,
  /** Log every decision to stderr (shows up in the opencode log). */
  debug: true,
};

const NETWORK_RE =
  /EAI_[A-Z]+|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|failed to fetch|terminated|other side closed|connection (?:closed|refused)|dns/i;

function rateLimitDelay(attempt, cfg) {
  // attempt is the physical attempt under consideration; the initial request
  // is 1, so the first retry is 2.
  const idx = Math.max(0, attempt - 2);
  const list = cfg.rateLimitDelays.length ? cfg.rateLimitDelays : DEFAULTS.rateLimitDelays;
  return Math.min(list[Math.min(idx, list.length - 1)], cfg.maxDelay);
}

function clamp(ms, cfg) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return DEFAULTS.networkDelay;
  return Math.min(Math.ceil(ms), cfg.maxDelay);
}

function decide(event, cfg) {
  const status = event.error && event.error.status;
  const type = event.error && event.error.type;
  const message = (event.error && event.error.message) || "";

  // 1. Rate limits. NIM: always force-retry, even if OpenCode classified it as
  //    a terminal quota failure because the body mentioned quota/limit words.
  if (status === 429 || type === "provider.rate-limit") {
    const delay = rateLimitDelay(event.attempt, cfg);
    return { retry: true, delay, why: `rate-limit(status=${status}) attempt=${event.attempt} delay=${delay}ms` };
  }

  // 2. Transient network / DNS. Retry fast so the limited attempt budget is not
  //    burned on long sleeps for a blip that recovers in a second.
  if (type === "provider.transport" || type === "provider.unknown" || NETWORK_RE.test(message)) {
    return { retry: true, delay: clamp(cfg.networkDelay, cfg), why: `network(${type || "?"}) ${message.slice(0, 80)}` };
  }

  // 3. Server-side hiccups (NIM also returns 5xx / cold-start errors).
  if ((typeof status === "number" && status >= 500) || type === "provider.internal") {
    return { retry: true, delay: clamp(cfg.serverErrorDelay, cfg), why: `server(status=${status})` };
  }

  // 4. Everything else (auth, invalid request, content policy, real quota,
  //    context overflow): leave OpenCode's decision untouched.
  return undefined;
}

export default {
  id: "nim-retry",
  async setup(ctx) {
    const cfg = { ...DEFAULTS, ...(ctx && ctx.options ? ctx.options : {}) };
    const session = ctx && ctx.session;

    if (!session || typeof session.hook !== "function") {
      console.error("[nim-retry] ctx.session.hook is unavailable; plugin disabled");
      return;
    }

    await session.hook(
      "retry",
      (event) => {
        const d = decide(event, cfg);
        if (!d) return; // keep OpenCode's decision
        event.decision = { retry: true, delay: d.delay };
        if (cfg.debug) {
          console.error(`[nim-retry] retry -> ${d.why} (raw=${event.error && event.error.type} "${(event.error && event.error.message || "").slice(0, 120)}")`);
        }
      },
      { providerID: cfg.providerId },
    );

    // Diagnostics: surface 429s that arrived without any retry hint, so you can
    // confirm NIM is the culprit and not something upstream.
    if (cfg.debug && typeof session.hook === "function") {
      await session.hook(
        "http.response",
        (event) => {
          try {
            const res = event.response;
            if (res && res.status === 429) {
              const ra = res.headers.get("retry-after") || res.headers.get("retry-after-ms");
              console.error(`[nim-retry] 429 from ${cfg.providerId} (kind=${event.kind}) retry-after=${ra ?? "<none>"}`);
            }
          } catch {
            /* diagnostics must never break a request */
          }
        },
        { providerID: cfg.providerId },
      );
    }
  },
};
