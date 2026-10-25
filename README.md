# opencode-nim-retry

An [OpenCode](https://opencode.ai) V2 plugin that makes NVIDIA NIM usable.

NIM's rate limiting breaks generic retry logic in two ways:

1. **429 with no retry hints.** NIM answers with `{"status":429,"title":"Too Many Requests"}` and
   **no `Retry-After` / `X-RateLimit-*` headers**. OpenCode then falls back to its built-in
   exponential backoff, which is capped at **10 s** (session layer) / **30 s** (request layer) and at
   ~10 attempts — roughly **1–2 minutes total**. NIM locks the **account** (not the key) for
   **minutes to hours**, so the retries always exhaust and the 429 surfaces.
2. **Hammering extends the lock.** The NIM limit is account-scoped and *grows while you keep
   requesting*. Patient, long waits beat fast retries. OpenCode fires parallel requests, which makes
   it worse.

A third, quieter problem: a 429 whose body happens to contain quota-ish wording is classified by
OpenCode as `provider.quota` (**not** retryable), and occasional `EAI_AGAIN` / DNS-socket failures
(`getaddrinfo`, `ENOTFOUND`, …) are not in OpenCode's transport whitelist and can land on an
unclassified, non-retried failure.

This plugin hooks the **retry policy** for the target provider and:

- force-retries **every 429** (even if OpenCode classified it as a terminal quota failure), with a
  **long escalating delay** (10 s → 30 s → 60 s → 120 s, clamp 300 s) so the limited attempt budget
  spans a NIM lockout window;
- force-retries **transient network / DNS errors** (`EAI_AGAIN`, `getaddrinfo`, `ENOTFOUND`,
  `ECONNRESET`, `socket hang up`, …) with a **short** delay, so blips don't burn the budget;
- force-retries **5xx / provider-internal** errors;
- leaves everything else (auth, invalid request, content policy, real quota, context overflow)
  untouched.

## Install

Clone it somewhere OpenCode can read, for example:

```sh
git clone https://github.com/Excurs1ons/opencode-nim-retry ~/.config/opencode/plugins/nim-retry
```

Then add it to the `plugins` array in your global `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "~/.config/opencode/plugins/nim-retry"
  ]
}
```

Use an absolute path (e.g. `/home/you/.config/opencode/plugins/nim-retry`) if `~` is not expanded by
your shell. OpenCode hot-reloads plugins when the config is saved.

Verify it loaded:

```sh
grep nim-retry ~/.local/share/opencode/log/opencode.log | tail
# ... msg="loading plugin" id=.../nim-retry entrypoint=file://.../index.ts
```

## Options

Pass options with the object form in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/nim-retry",
      "options": {
        "providerId": "nvidia",
        "rateLimitDelays": [10000, 30000, 60000, 120000],
        "maxDelay": 300000,
        "networkDelay": 2000,
        "serverErrorDelay": 5000,
        "debug": true
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `providerId` | `"nvidia"` | Only hook this provider. |
| `rateLimitDelays` | `[10000,30000,60000,120000]` | Delay schedule (ms) for 429 retries, indexed by attempt; the last entry repeats. |
| `maxDelay` | `300000` | Upper clamp for any delay the plugin sets (ms). |
| `networkDelay` | `2000` | Delay for transient network / DNS failures (ms). |
| `serverErrorDelay` | `5000` | Delay for 5xx / provider-internal failures (ms). |
| `debug` | `true` | Log every decision (and 429s seen without a `Retry-After`) to stderr / the OpenCode log. |

With `debug: true` you'll see lines like:

```
[nim-retry] retry -> rate-limit(status=429) attempt=2 delay=10000ms (raw=provider.rate-limit "Too Many Requests")
[nim-retry] 429 from nvidia (kind=primary) retry-after=<none>
```

## Limitations

- A plugin **cannot raise OpenCode's built-in maximum attempt count** ("The built-in maximum attempt
  count remains a hard limit"). A retry hook can only change `{ retry, delay }`. This plugin spends
  the limited attempts on long waits for rate limits.
- If a step's **streaming output has already started**, OpenCode will not retry that step at all, so
  the hook is never consulted for it.
- The real fix is on the NIM side: an account-level lock has to be waited out, or you switch
  accounts / providers. New API keys on the same account do **not** help.
- Consider also raising the provider timeouts for NIM cold starts (NIM can pause 10–60 s between SSE
  chunks):

```jsonc
{
  "providers": {
    "nvidia": { "settings": { "headerTimeout": 600000, "chunkTimeout": 900000 } }
  }
}
```

## License

MIT

---

## 中文说明

这是给 OpenCode 用的插件，专门对付 NVIDIA NIM 的 429：

- NIM 的 429 不带 `Retry-After`，OpenCode 内置退避又很低（10s 封顶、约 10 次、总共 1–2 分钟），
  而 NIM 是**账户级**封锁、持续几分钟到几小时，所以内置重试必然失败。
- 本插件把目标 provider 的所有 429 **强制视为可重试**，并给出**逐渐变长的等待**
  （10s→30s→60s→120s），让有限的重试次数尽量覆盖住封锁期；
- 对 `EAI_AGAIN` 等 DNS/网络抖动用**短延迟**快速重试；
- 对 5xx 也重试；其它错误（鉴权、请求非法、内容策略、真配额、上下文超限）不动。

**局限**：插件无法提高 OpenCode 的内置最大重试次数上限，只能改 `{retry, delay}`；
另外一旦流式输出已经开始，该步骤就不再重试。根治还得在 NIM 侧（等封锁过去、换账户或换 provider）。
