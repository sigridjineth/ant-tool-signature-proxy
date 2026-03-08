import { describe, expect, it } from "vitest";
import {
  buildForwardHeaders,
  ensureCommaSeparatedHeader,
  extractAnthropicApiKey,
  normalizeMountPath,
  resolveUpstreamPath,
  rewriteRequestBody,
} from "./proxy.js";

describe("proxy helpers", () => {
  it("normalizes mount paths", () => {
    expect(normalizeMountPath()).toBe("/");
    expect(normalizeMountPath("anthropic")).toBe("/anthropic");
    expect(normalizeMountPath("/anthropic/")).toBe("/anthropic");
  });

  it("resolves upstream paths for direct and mounted routes", () => {
    expect(
      resolveUpstreamPath({
        pathname: "/anthropic/v1/messages",
        mountPath: "/anthropic",
      }),
    ).toBe("/v1/messages");
    expect(
      resolveUpstreamPath({
        pathname: "/v1/messages/count_tokens",
        mountPath: "/anthropic",
      }),
    ).toBe("/v1/messages/count_tokens");
    expect(
      resolveUpstreamPath({
        pathname: "/anthropic/healthz",
        mountPath: "/anthropic",
      }),
    ).toBeNull();
  });

  it("rewrites request bodies according to the selected variant", () => {
    const rewritten = JSON.parse(
      rewriteRequestBody({
        upstreamPath: "/v1/messages",
        variantId: "openai-functions",
        upstreamBaseUrl: new URL("https://example.com"),
        bodyText: JSON.stringify({
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
          tool_choice: { type: "tool", name: "read" },
        }),
      }),
    ) as {
      tools: Array<{ type?: string; function?: { name?: string } }>;
      tool_choice?: { type?: string; function?: { name?: string } };
    };

    expect(rewritten.tools[0]?.type).toBe("function");
    expect(rewritten.tools[0]?.function?.name).toBe("read");
    expect(rewritten.tool_choice?.type).toBe("function");
    expect(rewritten.tool_choice?.function?.name).toBe("read");
  });

  it("falls back to Anthropic custom tools for openai variants against Anthropic upstreams", () => {
    const rewritten = JSON.parse(
      rewriteRequestBody({
        upstreamPath: "/v1/messages",
        variantId: "openai-functions-compact",
        upstreamBaseUrl: new URL("https://api.anthropic.com"),
        bodyText: JSON.stringify({
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: {
                type: "object",
                properties: {
                  path: { type: "string", title: "Path" },
                },
              },
            },
          ],
          tool_choice: { type: "tool", name: "read" },
        }),
      }),
    ) as {
      tools: Array<{
        type?: string;
        name?: string;
        input_schema?: { properties?: { path?: { title?: string } } };
      }>;
      tool_choice?: { type?: string; name?: string };
    };

    expect(rewritten.tools[0]?.type).toBe("custom");
    expect(rewritten.tools[0]?.name).toBe("read");
    expect(rewritten.tools[0]?.input_schema?.properties?.path?.title).toBeUndefined();
    expect(rewritten.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("preserves existing typed anthropic tools during Anthropic upstream fallback", () => {
    const rewritten = JSON.parse(
      rewriteRequestBody({
        upstreamPath: "/v1/messages",
        variantId: "openai-functions",
        upstreamBaseUrl: new URL("https://api.anthropic.com"),
        bodyText: JSON.stringify({
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              input_schema: {
                type: "object",
                properties: {
                  query: { type: "string", title: "Query" },
                },
              },
            },
          ],
        }),
      }),
    ) as {
      tools: Array<{
        type?: string;
        name?: string;
        input_schema?: { properties?: { query?: { title?: string } } };
      }>;
    };

    expect(rewritten.tools[0]?.type).toBe("web_search_20250305");
    expect(rewritten.tools[0]?.name).toBe("web_search");
    expect(rewritten.tools[0]?.input_schema?.properties?.query?.title).toBe("Query");
  });

  it("replaces incoming auth headers when an upstream API key is configured", () => {
    const headers = buildForwardHeaders({
      incomingHeaders: {
        "content-type": "application/json",
        "x-api-key": "incoming",
        authorization: "Bearer incoming",
        "anthropic-version": "2023-06-01",
      },
      authOverride: { mode: "api-key", value: "upstream-key" },
    });

    expect(headers).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "upstream-key",
    });
  });

  it("replaces incoming auth headers when an upstream bearer token is configured", () => {
    const headers = buildForwardHeaders({
      incomingHeaders: {
        "content-type": "application/json",
        "x-api-key": "incoming",
        authorization: "Bearer incoming",
        "anthropic-version": "2023-06-01",
      },
      authOverride: { mode: "bearer", value: "oauth-token" },
    });

    expect(headers).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer oauth-token",
    });
  });

  it("appends OAuth beta headers without duplicating existing values", () => {
    const headers = buildForwardHeaders({
      incomingHeaders: {
        "content-type": "application/json",
        "anthropic-beta": "files-api-2025-04-14",
      },
      authOverride: { mode: "bearer", value: "oauth-token" },
    });

    ensureCommaSeparatedHeader({
      headers,
      headerName: "anthropic-beta",
      value: "oauth-2025-04-20",
    });
    ensureCommaSeparatedHeader({
      headers,
      headerName: "anthropic-beta",
      value: "oauth-2025-04-20",
    });

    expect(headers).toEqual({
      "content-type": "application/json",
      "anthropic-beta": "files-api-2025-04-14, oauth-2025-04-20",
      authorization: "Bearer oauth-token",
    });
  });

  it("extracts Anthropic API keys from nested OAuth exchange payloads", () => {
    expect(
      extractAnthropicApiKey({
        data: {
          credentials: {
            api_key: "sk-ant-test-nested",
          },
        },
      }),
    ).toBe("sk-ant-test-nested");

    expect(
      extractAnthropicApiKey({
        ignored: ["not-a-key"],
        result: {
          tokens: ["still-not-a-key", " sk-ant-test-array "],
        },
      }),
    ).toBe("sk-ant-test-array");
  });
});
