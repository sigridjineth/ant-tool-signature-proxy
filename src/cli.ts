import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { URL } from "node:url";
import { TOOL_SIGNATURE_VARIANTS, type ToolSignatureVariant } from "./experiments.js";
import {
  buildForwardHeaders,
  ensureCommaSeparatedHeader,
  extractAnthropicApiKey,
  type ForwardAuthOverride,
  normalizeMountPath,
  resolveUpstreamPath,
  rewriteRequestBody,
  sanitizeResponseHeaders,
  type UpstreamAuthMode,
} from "./proxy.js";

const DEFAULT_CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const SUPPORTED_UPSTREAM_AUTH_MODES = [
  "passthrough",
  "api-key",
  "bearer",
  "claude-code-oauth-exchange",
] as const satisfies readonly UpstreamAuthMode[];

type CliConfig = {
  host: string;
  port: number;
  mountPath: string;
  upstreamBaseUrl: URL;
  variantId: ToolSignatureVariant["id"];
  upstreamAuthMode: UpstreamAuthMode;
  upstreamAuthEnv?: string;
  upstreamOauthBeta: string;
  upstreamOauthVersion: string;
  verbose: boolean;
};

type ExchangedApiKeyCache = {
  upstreamOrigin: string;
  oauthToken: string;
  apiKey: string;
};

type ExchangedApiKeyRequest = {
  upstreamOrigin: string;
  oauthToken: string;
  promise: Promise<string>;
};

let exchangedApiKeyCache: ExchangedApiKeyCache | null = null;
let exchangedApiKeyRequest: ExchangedApiKeyRequest | null = null;

function getArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    return undefined;
  }
  return argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function printHelp(): void {
  console.log(
    "Usage: tsx src/cli.ts --upstream-base-url <url> " +
      "[--listen 127.0.0.1:8787] [--mount-path /anthropic] " +
      "[--variant anthropic-native] [--upstream-auth passthrough] " +
      "[--upstream-auth-env ANTHROPIC_API_KEY] " +
      "[--upstream-oauth-beta oauth-2025-04-20] " +
      "[--upstream-oauth-version 2023-06-01] " +
      "[--verbose] [--list-variants]",
  );
}

function parseListen(raw: string | undefined): { host: string; port: number } {
  const input = raw?.trim() || "127.0.0.1:8787";
  const lastColon = input.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`Invalid --listen value "${input}". Expected host:port`);
  }
  const host = input.slice(0, lastColon).trim();
  const portRaw = input.slice(lastColon + 1).trim();
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --listen value "${input}". Expected host:port`);
  }
  return { host, port };
}

function resolveVariantId(raw: string | undefined): ToolSignatureVariant["id"] {
  const variant = raw?.trim() || "anthropic-native";
  const found = TOOL_SIGNATURE_VARIANTS.find((entry) => entry.id === variant);
  if (!found) {
    const supported = TOOL_SIGNATURE_VARIANTS.map((entry) => entry.id).join(", ");
    throw new Error(`Unknown --variant "${variant}". Supported values: ${supported}`);
  }
  return found.id;
}

function resolveUpstreamAuthMode(params: {
  rawMode?: string;
  hasAuthEnv: boolean;
  hasLegacyApiKeyEnv: boolean;
}): UpstreamAuthMode {
  const mode = params.rawMode?.trim() || (params.hasAuthEnv || params.hasLegacyApiKeyEnv ? "api-key" : "passthrough");
  if (SUPPORTED_UPSTREAM_AUTH_MODES.includes(mode as UpstreamAuthMode)) {
    return mode as UpstreamAuthMode;
  }
  throw new Error(
    `Unknown --upstream-auth "${mode}". Supported values: ${SUPPORTED_UPSTREAM_AUTH_MODES.join(", ")}`,
  );
}

function truncateForError(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "<empty response>";
  }
  return singleLine.length > 200 ? `${singleLine.slice(0, 200)}...` : singleLine;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function exchangeClaudeCodeOauthToken(params: {
  upstreamBaseUrl: URL;
  oauthToken: string;
  anthropicBeta: string;
  anthropicVersion: string;
  verbose: boolean;
}): Promise<string> {
  const upstreamOrigin = new URL(params.upstreamBaseUrl).origin;
  if (
    exchangedApiKeyCache?.upstreamOrigin === upstreamOrigin &&
    exchangedApiKeyCache.oauthToken === params.oauthToken
  ) {
    return exchangedApiKeyCache.apiKey;
  }
  if (
    exchangedApiKeyRequest?.upstreamOrigin === upstreamOrigin &&
    exchangedApiKeyRequest.oauthToken === params.oauthToken
  ) {
    return exchangedApiKeyRequest.promise;
  }

  const promise = (async () => {
    const exchangeUrl = new URL("/api/oauth/claude_cli/create_api_key", params.upstreamBaseUrl);
    if (params.verbose) {
      console.error(`[proxy] exchanging Claude Code OAuth token via ${exchangeUrl}`);
    }

    const exchangeResponse = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.oauthToken}`,
        "anthropic-beta": params.anthropicBeta,
        "anthropic-version": params.anthropicVersion,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const responseText = await exchangeResponse.text();

    if (!exchangeResponse.ok) {
      throw new Error(
        "Claude Code OAuth exchange failed with " +
          `${exchangeResponse.status} ${exchangeResponse.statusText}: ${truncateForError(responseText)}`,
      );
    }

    let parsedResponse: unknown = null;
    if (responseText.trim()) {
      try {
        parsedResponse = JSON.parse(responseText) as unknown;
      } catch {
        throw new Error(
          `Claude Code OAuth exchange returned non-JSON response: ${truncateForError(responseText)}`,
        );
      }
    }

    const exchangedApiKey = extractAnthropicApiKey(parsedResponse);
    if (!exchangedApiKey) {
      throw new Error("Claude Code OAuth exchange response did not include an Anthropic API key");
    }

    exchangedApiKeyCache = {
      upstreamOrigin,
      oauthToken: params.oauthToken,
      apiKey: exchangedApiKey,
    };
    return exchangedApiKey;
  })();

  exchangedApiKeyRequest = { upstreamOrigin, oauthToken: params.oauthToken, promise };
  try {
    return await promise;
  } finally {
    if (exchangedApiKeyRequest?.promise === promise) {
      exchangedApiKeyRequest = null;
    }
  }
}

async function resolveAuthOverride(config: CliConfig): Promise<ForwardAuthOverride | undefined> {
  if (config.upstreamAuthMode === "passthrough") {
    return undefined;
  }

  const upstreamAuthEnv = config.upstreamAuthEnv;
  if (!upstreamAuthEnv) {
    throw new Error(`Missing required --upstream-auth-env for mode ${config.upstreamAuthMode}`);
  }

  if (config.upstreamAuthMode === "api-key") {
    return { mode: "api-key", value: readRequiredEnv(upstreamAuthEnv) };
  }

  if (config.upstreamAuthMode === "bearer") {
    return { mode: "bearer", value: readRequiredEnv(upstreamAuthEnv) };
  }

  const exchangedApiKey = await exchangeClaudeCodeOauthToken({
    upstreamBaseUrl: config.upstreamBaseUrl,
    oauthToken: readRequiredEnv(upstreamAuthEnv),
    anthropicBeta: config.upstreamOauthBeta,
    anthropicVersion: config.upstreamOauthVersion,
    verbose: config.verbose,
  });
  return { mode: "api-key", value: exchangedApiKey };
}

function parseConfig(): CliConfig {
  if (hasFlag("--help")) {
    printHelp();
    process.exit(0);
  }
  if (hasFlag("--list-variants")) {
    for (const variant of TOOL_SIGNATURE_VARIANTS) {
      console.log(`${variant.id}  ${variant.description}`);
    }
    process.exit(0);
  }

  const upstreamBaseUrlRaw = getArg("--upstream-base-url");
  if (!upstreamBaseUrlRaw) {
    throw new Error("Missing required --upstream-base-url");
  }

  const rawUpstreamAuthMode = getArg("--upstream-auth");
  const legacyUpstreamApiKeyEnv = getArg("--upstream-api-key-env")?.trim() || undefined;
  const explicitUpstreamAuthEnv = getArg("--upstream-auth-env")?.trim() || undefined;
  if (
    legacyUpstreamApiKeyEnv &&
    explicitUpstreamAuthEnv &&
    legacyUpstreamApiKeyEnv !== explicitUpstreamAuthEnv
  ) {
    throw new Error("Use either --upstream-api-key-env or --upstream-auth-env, not both");
  }

  const upstreamAuthMode = resolveUpstreamAuthMode({
    rawMode: rawUpstreamAuthMode,
    hasAuthEnv: Boolean(explicitUpstreamAuthEnv),
    hasLegacyApiKeyEnv: Boolean(legacyUpstreamApiKeyEnv),
  });
  if (legacyUpstreamApiKeyEnv && upstreamAuthMode !== "api-key") {
    throw new Error("--upstream-api-key-env can only be used with --upstream-auth api-key");
  }

  const upstreamAuthEnv = explicitUpstreamAuthEnv || legacyUpstreamApiKeyEnv;
  if (upstreamAuthMode === "passthrough" && upstreamAuthEnv) {
    throw new Error("--upstream-auth-env requires --upstream-auth api-key, bearer, or claude-code-oauth-exchange");
  }
  if (upstreamAuthMode !== "passthrough" && !upstreamAuthEnv) {
    throw new Error(`--upstream-auth ${upstreamAuthMode} requires --upstream-auth-env <name>`);
  }

  const { host, port } = parseListen(getArg("--listen"));
  return {
    host,
    port,
    mountPath: normalizeMountPath(getArg("--mount-path") || "/anthropic"),
    upstreamBaseUrl: new URL(upstreamBaseUrlRaw),
    variantId: resolveVariantId(getArg("--variant")),
    upstreamAuthMode,
    upstreamAuthEnv,
    upstreamOauthBeta: getArg("--upstream-oauth-beta")?.trim() || DEFAULT_CLAUDE_CODE_OAUTH_BETA,
    upstreamOauthVersion:
      getArg("--upstream-oauth-version")?.trim() || DEFAULT_ANTHROPIC_VERSION,
    verbose: hasFlag("--verbose"),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function copyResponseHeaders(headers: Headers, res: ServerResponse): void {
  for (const [key, value] of Object.entries(sanitizeResponseHeaders(headers))) {
    res.setHeader(key, value);
  }
}

async function main(): Promise<void> {
  const config = parseConfig();
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && requestUrl.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            mountPath: config.mountPath,
            upstreamBaseUrl: config.upstreamBaseUrl.toString(),
            variantId: config.variantId,
            upstreamAuthMode: config.upstreamAuthMode,
          }),
        );
        return;
      }

      const upstreamPath = resolveUpstreamPath({
        pathname: requestUrl.pathname,
        mountPath: config.mountPath,
      });
      if (!upstreamPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unsupported path" }));
        return;
      }

      const bodyText = await readRequestBody(req);
      const rewrittenBody = rewriteRequestBody({
        bodyText,
        upstreamPath,
        variantId: config.variantId,
        upstreamBaseUrl: config.upstreamBaseUrl,
      });
      const upstreamUrl = new URL(upstreamPath + requestUrl.search, config.upstreamBaseUrl);
      const authOverride = await resolveAuthOverride(config);
      const headers = buildForwardHeaders({
        incomingHeaders: req.headers,
        authOverride,
      });
      if (config.upstreamAuthMode === "bearer") {
        ensureCommaSeparatedHeader({
          headers,
          headerName: "anthropic-beta",
          value: config.upstreamOauthBeta,
        });
      }

      if (config.verbose) {
        console.error(
          `[proxy] ${req.method} ${requestUrl.pathname} -> ${upstreamUrl} variant=${config.variantId} auth=${config.upstreamAuthMode}`,
        );
      }

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : rewrittenBody,
      });

      res.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, res);
      if (!upstreamResponse.body || req.method === "HEAD") {
        res.end();
        return;
      }

      res.flushHeaders();
      await pipeline(
        Readable.fromWeb(upstreamResponse.body as unknown as WebReadableStream<Uint8Array>),
        res,
      );
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  server.listen(config.port, config.host, () => {
    const baseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    console.error(
      `[proxy] listening on ${baseUrl} -> ${config.upstreamBaseUrl} variant=${config.variantId} auth=${config.upstreamAuthMode}`,
    );
  });
}

void main();
