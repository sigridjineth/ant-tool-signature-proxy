import { describe, expect, it } from "vitest";
import { applyToolSignatureVariant } from "./experiments.js";

describe("tool signature experiments", () => {
  function buildPayload() {
    return {
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path", title: "Path" },
              offset: { type: "number", title: "Offset" },
            },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    };
  }

  it("preserves anthropic-native payloads", () => {
    expect(applyToolSignatureVariant(buildPayload(), "anthropic-native")).toEqual(buildPayload());
  });

  it("adds explicit custom tool types for anthropic explicit-custom variants", () => {
    expect(applyToolSignatureVariant(buildPayload(), "anthropic-explicit-custom")).toEqual({
      tools: [
        {
          type: "custom",
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path", title: "Path" },
              offset: { type: "number", title: "Offset" },
            },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    });
  });

  it("preserves existing typed anthropic tools", () => {
    expect(
      applyToolSignatureVariant(
        {
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
        },
        "anthropic-explicit-custom-compact",
      ),
    ).toEqual({
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      ],
    });
  });

  it("converts payloads to OpenAI function envelopes", () => {
    expect(applyToolSignatureVariant(buildPayload(), "openai-functions")).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path", title: "Path" },
                offset: { type: "number", title: "Offset" },
              },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
    });
  });

  it("strips title fields for compact variants", () => {
    expect(applyToolSignatureVariant(buildPayload(), "openai-functions-compact")).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path" },
                offset: { type: "number" },
              },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
    });
  });

  it("adds strict=false when requested", () => {
    expect(applyToolSignatureVariant(buildPayload(), "openai-functions-strict")).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path", title: "Path" },
                offset: { type: "number", title: "Offset" },
              },
              required: ["path"],
            },
            strict: false,
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
    });
  });

  it("maps required back to anthropic any", () => {
    expect(
      applyToolSignatureVariant(
        {
          tools: [],
          tool_choice: "required",
        },
        "anthropic-native",
      ),
    ).toEqual({
      tools: [],
      tool_choice: { type: "any" },
    });
  });
});
