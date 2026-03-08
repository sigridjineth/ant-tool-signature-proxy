# anthropic-tool-signature-proxy

Small local reverse proxy for experimenting with Anthropic-compatible tool payload variants.

It accepts Anthropic-style requests on a local port, rewrites only `tools` and `tool_choice`, then forwards the request to a real upstream server.

## What It Does

- Receives `POST /v1/messages`
- Receives `POST /v1/messages/count_tokens`
- Optionally mounts those paths under a prefix such as `/anthropic`
- Rewrites tool payload shape according to a selected variant
- Forwards the request to a real upstream server
- Returns the upstream response unchanged

It does not:

- generate credentials
- extract OAuth tokens
- emulate model responses

## Variants

- `anthropic-native`
- `anthropic-native-compact`
- `openai-functions`
- `openai-functions-compact`
- `openai-functions-strict`

## Setup

```bash
pnpm install
```

## Run

```bash
ANTHROPIC_API_KEY=your-key \
pnpm dev -- \
  --upstream-base-url https://api.anthropic.com \
  --variant openai-functions \
  --upstream-api-key-env ANTHROPIC_API_KEY \
  --verbose
```

By default the proxy listens on `127.0.0.1:8787` and expects the client to call it through `/anthropic`.

That means your local client can use:

```text
http://127.0.0.1:8787/anthropic
```

and the proxy will forward:

- `/anthropic/v1/messages` -> `https://api.anthropic.com/v1/messages`
- `/anthropic/v1/messages/count_tokens` -> `https://api.anthropic.com/v1/messages/count_tokens`

## Options

```text
--upstream-base-url <url>       Required upstream base URL
--listen <host:port>            Default: 127.0.0.1:8787
--mount-path <path>             Default: /anthropic
--variant <id>                  Default: anthropic-native
--upstream-api-key-env <name>   Env var to use as upstream x-api-key
--verbose                       Print forwarding logs
--list-variants                 Print supported variants
--help                          Show usage
```

## Health Check

```bash
curl http://127.0.0.1:8787/healthz
```

## Test

```bash
pnpm test
```
