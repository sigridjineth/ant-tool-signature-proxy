import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { TOOL_SIGNATURE_VARIANTS, type ToolSignatureVariant } from "./experiments.js";
import {
  buildForwardHeaders,
  normalizeMountPath,
  resolveUpstreamPath,
  rewriteRequestBody,
} from "./proxy.js";

type CliConfig = {
  host: string;
  port: number;
  mountPath: string;
  upstreamBaseUrl: URL;
  variantId: ToolSignatureVariant["id"];
  upstreamApiKeyEnv?: string;
  verbose: boolean;
};

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
      "[--variant anthropic-native] [--upstream-api-key-env ANTHROPIC_API_KEY] " +
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

  const { host, port } = parseListen(getArg("--listen"));
  return {
    host,
    port,
    mountPath: normalizeMountPath(getArg("--mount-path") || "/anthropic"),
    upstreamBaseUrl: new URL(upstreamBaseUrlRaw),
    variantId: resolveVariantId(getArg("--variant")),
    upstreamApiKeyEnv: getArg("--upstream-api-key-env")?.trim() || undefined,
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
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "connection" || key.toLowerCase() === "transfer-encoding") {
      continue;
    }
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
      });
      const upstreamApiKey = config.upstreamApiKeyEnv
        ? process.env[config.upstreamApiKeyEnv]?.trim()
        : undefined;
      const upstreamUrl = new URL(upstreamPath + requestUrl.search, config.upstreamBaseUrl);
      const headers = buildForwardHeaders({
        incomingHeaders: req.headers,
        upstreamApiKey,
      });

      if (config.verbose) {
        console.error(
          `[proxy] ${req.method} ${requestUrl.pathname} -> ${upstreamUrl} variant=${config.variantId}`,
        );
      }

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : rewrittenBody,
      });
      const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

      res.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, res);
      res.end(responseBuffer);
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
      `[proxy] listening on ${baseUrl} -> ${config.upstreamBaseUrl} variant=${config.variantId}`,
    );
  });
}

void main();
