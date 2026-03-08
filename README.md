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
- mint or validate OAuth tokens
- emulate model responses

## Variants

- `anthropic-native`
- `anthropic-native-compact`
- `anthropic-explicit-custom`
- `anthropic-explicit-custom-compact`
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
  --upstream-auth api-key \
  --upstream-auth-env ANTHROPIC_API_KEY \
  --verbose
```

For a bearer token passthrough override instead:

```bash
CLAUDE_CODE_OAUTH_TOKEN=your-token \
pnpm dev -- \
  --upstream-base-url https://api.anthropic.com \
  --variant openai-functions \
  --upstream-auth bearer \
  --upstream-auth-env CLAUDE_CODE_OAUTH_TOKEN \
  --verbose
```

In bearer mode, the proxy also ensures `anthropic-beta: oauth-2025-04-20` is present on forwarded requests unless the client already sent that beta value.

When the upstream host is Anthropic itself, the `openai-functions*` variants are automatically
translated to the corresponding `anthropic-explicit-custom*` shape. Anthropic's current
`/v1/messages` API rejects literal OpenAI `type: "function"` tool envelopes.

For Claude Code OAuth token exchange to an Anthropic API key:

```bash
CLAUDE_CODE_OAUTH_TOKEN=your-token \
pnpm dev -- \
  --upstream-base-url https://api.anthropic.com \
  --variant openai-functions \
  --upstream-auth claude-code-oauth-exchange \
  --upstream-auth-env CLAUDE_CODE_OAUTH_TOKEN \
  --verbose
```

The exchange flow calls `POST /api/oauth/claude_cli/create_api_key` on the upstream origin, sends the OAuth token as `Authorization: Bearer ...`, and then caches the returned Anthropic API key in memory for the life of the proxy process.

## OpenClaw Comparison

OpenClaw-style Claude compatibility and Anthropic wire format are two different layers.

OpenClaw strict-compat surface:

```json
[
  { "name": "Read", "description": "Read file" },
  { "name": "Write", "description": "Write file" },
  { "name": "Edit", "description": "Edit file" },
  { "name": "Bash", "description": "Run shell commands" }
]
```

This is the outward tool surface shown to the model in Anthropic OAuth strict-compat mode.
It makes the tool inventory look more Claude-like by reducing OpenClaw-specific tools and
renaming canonical internal tools such as `exec` to `Bash`.

Anthropic wire payload:

```json
{
  "tools": [
    {
      "name": "read",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      },
      "description": "Read file",
      "type": "custom"
    }
  ],
  "tool_choice": {
    "type": "tool",
    "name": "read"
  }
}
```

This is what Anthropic's Messages API accepts today. The important point is that Claude-like
tool names on the model-facing surface do not mean Anthropic receives an OpenAI function
envelope on the wire.

Proxy rewrite behavior:

Client sends OpenAI-style function tools:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          }
        }
      }
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": { "name": "read" }
  }
}
```

When the upstream is Anthropic itself, this proxy rewrites it to:

```json
{
  "tools": [
    {
      "type": "custom",
      "name": "read",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        }
      }
    }
  ],
  "tool_choice": {
    "type": "tool",
    "name": "read"
  }
}
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
--upstream-auth <mode>          passthrough | api-key | bearer | claude-code-oauth-exchange
--upstream-auth-env <name>      Env var to use for the configured upstream auth mode
--upstream-api-key-env <name>   Deprecated alias for --upstream-auth api-key --upstream-auth-env
--upstream-oauth-beta <value>   Default: oauth-2025-04-20
--upstream-oauth-version <date> Default: 2023-06-01
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
