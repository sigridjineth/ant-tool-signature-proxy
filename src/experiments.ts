export type ToolLike = {
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  type?: unknown;
  function?: unknown;
};

export type ToolSignatureVariant = {
  id:
    | "anthropic-native"
    | "anthropic-native-compact"
    | "openai-functions"
    | "openai-functions-compact"
    | "openai-functions-strict";
  description: string;
  envelope: "anthropic" | "openai-function";
  schemaStyle: "preserve" | "compact";
  strict?: boolean;
};

export const TOOL_SIGNATURE_VARIANTS = [
  {
    id: "anthropic-native",
    description: "Anthropic-native tools using name + input_schema.",
    envelope: "anthropic",
    schemaStyle: "preserve",
  },
  {
    id: "anthropic-native-compact",
    description: "Anthropic-native tools with schema titles stripped recursively.",
    envelope: "anthropic",
    schemaStyle: "compact",
  },
  {
    id: "openai-functions",
    description: "OpenAI function envelope with function.parameters.",
    envelope: "openai-function",
    schemaStyle: "preserve",
  },
  {
    id: "openai-functions-compact",
    description: "OpenAI function envelope with schema titles stripped recursively.",
    envelope: "openai-function",
    schemaStyle: "compact",
  },
  {
    id: "openai-functions-strict",
    description: "OpenAI function envelope with an explicit strict=false flag.",
    envelope: "openai-function",
    schemaStyle: "preserve",
    strict: false,
  },
] as const satisfies readonly ToolSignatureVariant[];

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => compactSchema(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "title") {
      continue;
    }
    compacted[key] = compactSchema(entry);
  }
  return compacted;
}

function normalizeSchema(
  schema: unknown,
  style: ToolSignatureVariant["schemaStyle"],
): Record<string, unknown> {
  const base = isRecord(schema)
    ? cloneValue(schema)
    : ({ type: "object", properties: {} } as Record<string, unknown>);
  return style === "compact" ? (compactSchema(base) as Record<string, unknown>) : base;
}

function toAnthropicToolShape(
  tool: ToolLike | Record<string, unknown>,
  style: ToolSignatureVariant["schemaStyle"],
): Record<string, unknown> {
  const record = tool as Record<string, unknown>;
  if (isRecord(record.function)) {
    const functionSpec = record.function;
    const next: Record<string, unknown> = {
      name: typeof functionSpec.name === "string" ? functionSpec.name : record.name,
      input_schema: normalizeSchema(functionSpec.parameters, style),
    };
    if (typeof functionSpec.description === "string" && functionSpec.description.trim()) {
      next.description = functionSpec.description;
    }
    return next;
  }

  const next: Record<string, unknown> = {
    name: tool.name,
    input_schema: normalizeSchema(tool.parameters ?? record.input_schema, style),
  };
  if (typeof tool.description === "string" && tool.description.trim()) {
    next.description = tool.description;
  }
  return next;
}

function toOpenAiFunctionToolShape(
  tool: ToolLike | Record<string, unknown>,
  variant: ToolSignatureVariant,
): Record<string, unknown> {
  const record = tool as Record<string, unknown>;
  if (record.type === "function" && isRecord(record.function)) {
    const next = cloneValue(record);
    const functionSpec = next.function as Record<string, unknown>;
    functionSpec.parameters = normalizeSchema(functionSpec.parameters, variant.schemaStyle);
    if (typeof variant.strict === "boolean") {
      functionSpec.strict = variant.strict;
    } else {
      delete functionSpec.strict;
    }
    return next;
  }

  const functionSpec: Record<string, unknown> = {
    name: tool.name,
    parameters: normalizeSchema(tool.parameters ?? record.input_schema, variant.schemaStyle),
  };
  if (typeof tool.description === "string" && tool.description.trim()) {
    functionSpec.description = tool.description;
  }
  if (typeof variant.strict === "boolean") {
    functionSpec.strict = variant.strict;
  }
  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeToolChoiceForAnthropic(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice)) {
    return toolChoice === "required" ? { type: "any" } : toolChoice;
  }
  if (toolChoice.type === "function" && isRecord(toolChoice.function)) {
    const functionName = toolChoice.function.name;
    if (typeof functionName === "string" && functionName.trim()) {
      return {
        type: "tool",
        name: functionName.trim(),
      };
    }
  }
  if (toolChoice.type === "required") {
    return { type: "any" };
  }
  return cloneValue(toolChoice);
}

function normalizeToolChoiceForOpenAi(toolChoice: unknown): unknown {
  if (toolChoice === "required") {
    return toolChoice;
  }
  if (!isRecord(toolChoice)) {
    return toolChoice;
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (
    toolChoice.type === "tool" &&
    typeof toolChoice.name === "string" &&
    toolChoice.name.trim()
  ) {
    return {
      type: "function",
      function: { name: toolChoice.name.trim() },
    };
  }
  if (
    (toolChoice.type === "auto" || toolChoice.type === "none") &&
    typeof toolChoice.type === "string"
  ) {
    return toolChoice.type;
  }
  return cloneValue(toolChoice);
}

export function resolveToolSignatureVariant(
  id: ToolSignatureVariant["id"],
): ToolSignatureVariant {
  const found = TOOL_SIGNATURE_VARIANTS.find((variant) => variant.id === id);
  if (!found) {
    throw new Error(`Unknown tool signature variant: ${id}`);
  }
  return found;
}

export function applyToolSignatureVariant(
  payload: Record<string, unknown>,
  variantId: ToolSignatureVariant["id"],
): Record<string, unknown> {
  const variant = resolveToolSignatureVariant(variantId);
  const next = cloneValue(payload);

  if (Array.isArray(next.tools)) {
    next.tools =
      variant.envelope === "anthropic"
        ? next.tools
            .map((tool) =>
              isRecord(tool) ? toAnthropicToolShape(tool, variant.schemaStyle) : undefined,
            )
            .filter((tool): tool is Record<string, unknown> => !!tool)
        : next.tools
            .map((tool) =>
              isRecord(tool) ? toOpenAiFunctionToolShape(tool, variant) : undefined,
            )
            .filter((tool): tool is Record<string, unknown> => !!tool);
  }

  if ("tool_choice" in next) {
    next.tool_choice =
      variant.envelope === "anthropic"
        ? normalizeToolChoiceForAnthropic(next.tool_choice)
        : normalizeToolChoiceForOpenAi(next.tool_choice);
  }

  return next;
}
