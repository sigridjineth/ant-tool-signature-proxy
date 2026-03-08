import type { IncomingHttpHeaders } from "node:http";
import { applyToolSignatureVariant, type ToolSignatureVariant } from "./experiments.js";

const SUPPORTED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-";

export type ProxyConfig = {
  mountPath: string;
  variantId: ToolSignatureVariant["id"];
};

export type UpstreamAuthMode =
  | "passthrough"
  | "api-key"
  | "bearer"
  | "claude-code-oauth-exchange";

export type ForwardAuthOverride =
  | { mode: "api-key"; value: string }
  | { mode: "bearer"; value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicOrigin(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

function resolveAnthropicCompatibleVariant(
  variantId: ToolSignatureVariant["id"],
): ToolSignatureVariant["id"] {
  if (variantId === "openai-functions-compact") {
    return "anthropic-explicit-custom-compact";
  }
  return "anthropic-explicit-custom";
}

export function normalizeMountPath(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function resolveUpstreamPath(params: {
  pathname: string;
  mountPath?: string;
}): string | null {
  const mountPath = normalizeMountPath(params.mountPath);
  const pathname = params.pathname || "/";

  if (SUPPORTED_PATHS.has(pathname)) {
    return pathname;
  }

  if (mountPath !== "/" && pathname.startsWith(`${mountPath}/`)) {
    const stripped = pathname.slice(mountPath.length);
    return SUPPORTED_PATHS.has(stripped) ? stripped : null;
  }

  return null;
}

export function rewriteRequestBody(params: {
  bodyText: string;
  upstreamPath: string;
  variantId: ToolSignatureVariant["id"];
  upstreamBaseUrl: URL;
}): string {
  if (!SUPPORTED_PATHS.has(params.upstreamPath)) {
    return params.bodyText;
  }
  if (!params.bodyText.trim()) {
    return params.bodyText;
  }

  const parsed = JSON.parse(params.bodyText) as unknown;
  if (!isRecord(parsed)) {
    return params.bodyText;
  }

  const rewritten =
    params.variantId.startsWith("openai-functions") && isAnthropicOrigin(params.upstreamBaseUrl)
      ? applyToolSignatureVariant(parsed, resolveAnthropicCompatibleVariant(params.variantId))
      : applyToolSignatureVariant(parsed, params.variantId);
  return JSON.stringify(rewritten);
}

export function buildForwardHeaders(params: {
  incomingHeaders: IncomingHttpHeaders;
  authOverride?: ForwardAuthOverride;
}): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.incomingHeaders)) {
    if (!value) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "content-length" ||
      normalized === "connection" ||
      normalized === "x-forwarded-for"
    ) {
      continue;
    }
    if (params.authOverride && (normalized === "x-api-key" || normalized === "authorization")) {
      continue;
    }
    next[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (params.authOverride?.mode === "api-key") {
    next["x-api-key"] = params.authOverride.value;
  }
  if (params.authOverride?.mode === "bearer") {
    next.authorization = `Bearer ${params.authOverride.value}`;
  }
  return next;
}

export function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (
      normalized === "connection" ||
      normalized === "keep-alive" ||
      normalized === "transfer-encoding" ||
      normalized === "content-length" ||
      normalized === "content-encoding"
    ) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function ensureCommaSeparatedHeader(params: {
  headers: Record<string, string>;
  headerName: string;
  value: string;
}): void {
  const existingKey =
    Object.keys(params.headers).find((key) => key.toLowerCase() === params.headerName.toLowerCase()) ||
    params.headerName;
  const currentValue = params.headers[existingKey];
  if (!currentValue) {
    params.headers[existingKey] = params.value;
    return;
  }

  const values = currentValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.includes(params.value)) {
    values.push(params.value);
  }
  params.headers[existingKey] = values.join(", ");
}

export function extractAnthropicApiKey(value: unknown): string | null {
  return findAnthropicApiKey(value, new Set<object>());
}

function findAnthropicApiKey(value: unknown, seen: Set<object>): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.startsWith(ANTHROPIC_API_KEY_PREFIX) ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAnthropicApiKey(item, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const nested of Object.values(value)) {
    const found = findAnthropicApiKey(nested, seen);
    if (found) {
      return found;
    }
  }
  return null;
}
