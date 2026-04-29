import { createHash } from "node:crypto";

import type {
  AssistantMessage,
  Context as PiContext,
  Model as PiModel,
  Tool as PiTool,
} from "@mariozechner/pi-ai";

import { QueuedProviderStream, createEmptyUsage } from "@local-ai-gateway/shared";

export interface LocalCodexResponsesOptions {
  apiKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  textVerbosity?: "low" | "medium" | "high";
}

type ResponseStreamEvent = Record<string, unknown> & {
  type?: string;
};

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createOutput(model: PiModel<"openai-codex-responses">): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function clampReasoningEffort(
  modelId: string,
  effort: LocalCodexResponsesOptions["reasoningEffort"],
) {
  if (!effort) {
    return undefined;
  }
  const id = modelId.includes("/") ? modelId.split("/").pop() ?? modelId : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) &&
    effort === "minimal"
  ) {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") {
    return "high";
  }
  if (id === "gpt-5.1-codex-mini") {
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  }
  return effort;
}

function resolveCodexUrl(baseUrl?: string) {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token");
    }
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claim = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    const accountId = claim?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) {
      throw new Error("No account id in token");
    }
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function buildHeaders(
  accountId: string,
  token: string,
  sessionId?: string,
): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set(
    "User-Agent",
    `local-ai-gateway (${process.platform} ${process.arch})`,
  );
  if (sessionId) {
    headers.set("session_id", sessionId);
  }
  return headers;
}

function buildRequestBody(
  model: PiModel<"openai-codex-responses">,
  context: PiContext,
  options: LocalCodexResponsesOptions,
) {
  const messages = convertResponsesMessagesLocal(
    model,
    context,
  );
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt,
    input: messages,
    text: { verbosity: options.textVerbosity || "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (context.tools) {
    body.tools = convertResponsesToolsLocal(context.tools);
  }
  if (options.reasoningEffort !== undefined) {
    body.reasoning = {
      effort: clampReasoningEffort(model.id, options.reasoningEffort),
      summary: options.reasoningSummary ?? "auto",
    };
  }
  return body;
}

function convertResponsesMessagesLocal(
  model: PiModel<"openai-codex-responses">,
  context: PiContext,
) {
  const messages: Array<Record<string, unknown>> = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else {
        messages.push({
          role: "user",
          content: msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: item.text }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ),
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            try {
              messages.push(JSON.parse(block.thinkingSignature) as Record<string, unknown>);
            } catch {
              // ignore malformed signatures
            }
          }
          continue;
        }

        if (block.type === "text") {
          messages.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            status: "completed",
            id: `msg_${shortHash(block.text)}`,
          });
          continue;
        }

        if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          let itemId = itemIdRaw || `fc_${shortHash(callId)}`;
          if (!itemId.startsWith("fc_")) {
            itemId = `fc_${shortHash(itemId)}`;
          }
          messages.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: textResult || "(empty tool result)",
      });
    }
  }

  return messages;
}

function convertResponsesToolsLocal(tools: PiTool[]) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: null,
  }));
}

function isRetryableError(status: number, errorText: string) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Request was aborted"));
      },
      { once: true },
    );
  });
}

async function parseErrorResponse(response: Response) {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | undefined;
    if (err && typeof err.message === "string" && err.message) {
      message = err.message;
    }
  } catch {
    // ignore JSON parse failure
  }
  return { message };
}

async function* parseSSE(response: Response): AsyncGenerator<ResponseStreamEvent> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as ResponseStreamEvent;
            } catch {
              // ignore malformed chunks
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
    try {
      reader.releaseLock();
    } catch {
      // noop
    }
  }
}

function parseStreamingJson(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapStopReason(status: unknown): AssistantMessage["stopReason"] {
  if (status === "incomplete") {
    return "length";
  }
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  return "stop";
}

function applyCompletedUsage(output: AssistantMessage, response: Record<string, unknown>) {
  const usage = response.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return;
  }
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const hasCachedTokens = Boolean(
    inputDetails && "cached_tokens" in inputDetails,
  );
  const hasReasoningTokens = Boolean(
    outputDetails && "reasoning_tokens" in outputDetails,
  );
  const cachedTokens = normalizeNumber(inputDetails?.cached_tokens);
  const reasoningTokens = normalizeNumber(outputDetails?.reasoning_tokens);
  const nextUsage = {
    ...createEmptyUsage(),
    input: Math.max(0, normalizeNumber(usage.input_tokens) - cachedTokens),
    output: normalizeNumber(usage.output_tokens),
    totalTokens: normalizeNumber(usage.total_tokens),
  } as AssistantMessage["usage"] & { reasoningOutputTokens: number };
  if (hasCachedTokens) {
    nextUsage.cacheRead = cachedTokens;
  }
  if (hasReasoningTokens) {
    nextUsage.reasoningOutputTokens = reasoningTokens;
  }
  output.usage = nextUsage;
}

async function processResponsesStreamWithUsageDetails(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: QueuedProviderStream,
) {
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock:
    | ({ type: "thinking"; thinking: string; thinkingSignature?: string })
    | ({ type: "text"; text: string; textSignature?: string })
    | ({
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        partialJson: string;
      })
    | null = null;

  const blockIndex = () => output.content.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      continue;
    }

    if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock as never);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
        continue;
      }
      if (item?.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock as never);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        continue;
      }
      if (item?.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${String(item.call_id ?? "")}|${String(item.id ?? "")}`,
          name: String(item.name ?? "tool"),
          arguments: {},
          partialJson: String(item.arguments ?? ""),
        };
        output.content.push(currentBlock as never);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_text.delta") {
      if (currentBlock?.type === "thinking") {
        currentBlock.thinking += String(event.delta ?? "");
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: String(event.delta ?? ""),
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (currentBlock?.type === "text") {
        currentBlock.text += String(event.delta ?? "");
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: String(event.delta ?? ""),
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      if (currentBlock?.type === "toolCall") {
        const delta = String(event.delta ?? "");
        currentBlock.partialJson += delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      if (currentBlock?.type === "toolCall") {
        currentBlock.partialJson = String(event.arguments ?? "{}");
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
      continue;
    }

    if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
        continue;
      }
      if (item?.type === "message" && currentBlock?.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
        continue;
      }
      if (item?.type === "function_call" && currentBlock?.type === "toolCall") {
        const toolCall = {
          type: "toolCall" as const,
          id: currentBlock.id,
          name: currentBlock.name,
          arguments: currentBlock.arguments,
        };
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
        currentBlock = null;
      }
      continue;
    }

    if (
      event.type === "response.completed" ||
      event.type === "response.done" ||
      event.type === "response.incomplete"
    ) {
      const response = (event.response ?? {}) as Record<string, unknown>;
      if (typeof response.id === "string") {
        output.responseId = response.id;
      }
      applyCompletedUsage(output, response);
      output.stopReason = mapStopReason(response.status);
      if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
      return;
    }

    if (event.type === "error") {
      throw new Error(`Error Code ${String(event.code ?? "")}: ${String(event.message ?? "Unknown error")}`);
    }

    if (event.type === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      const details = response?.incomplete_details as Record<string, unknown> | undefined;
      const message =
        typeof error?.message === "string"
          ? `${String(error.code ?? "unknown")}: ${error.message}`
          : typeof details?.reason === "string"
            ? `incomplete: ${details.reason}`
            : "Unknown error (no error details in response)";
      throw new Error(message);
    }
  }
}

async function* mapCodexEvents(
  events: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ResponseStreamEvent> {
  for await (const event of events) {
    const type = event.type;
    if (!type) {
      continue;
    }
    if (type === "error") {
      const code = String(event.code ?? "");
      const message = String(event.message ?? "");
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === "string" ? error.message : "Codex response failed";
      throw new Error(message);
    }
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
      const response = event.response as Record<string, unknown> | undefined;
      yield {
        ...event,
        type: "response.completed",
        response,
      };
      return;
    }
    yield event;
  }
}

export function streamLocalOpenAICodexResponses(
  model: PiModel<"openai-codex-responses">,
  context: PiContext,
  options: LocalCodexResponsesOptions,
) {
  const stream = new QueuedProviderStream();
  const output = createOutput(model);

  void (async () => {
    try {
      const accountId = extractAccountId(options.apiKey);
      const body = buildRequestBody(model, context, options);
      const bodyJson = JSON.stringify(body);
      const headers = buildHeaders(accountId, options.apiKey, options.sessionId);

      let response: Response | undefined;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (options.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        try {
          response = await fetch(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers,
            body: bodyJson,
            signal: options.signal,
          });

          if (response.ok) {
            break;
          }

          const errorText = await response.text();
          const retryAfterHeader = response.headers.get("retry-after")?.trim();
          if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
            await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
            continue;
          }

          const fakeResponse = new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
          });
          const info = await parseErrorResponse(fakeResponse);
          const retryAfterHint = retryAfterHeader
            ? `[retry-after:${retryAfterHeader}]`
            : "";
          throw new Error(`[status:${response.status}]${retryAfterHint} ${info.message}`);
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (normalized.name === "AbortError" || normalized.message === "Request was aborted") {
            throw new Error("Request was aborted");
          }
          lastError = normalized;
          if (attempt < MAX_RETRIES && !normalized.message.includes("usage limit")) {
            await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
            continue;
          }
          throw normalized;
        }
      }

      if (!response?.ok) {
        throw lastError ?? new Error("Failed after retries");
      }

      stream.push({ type: "start", partial: output });
      await processResponsesStreamWithUsageDetails(
        mapCodexEvents(parseSSE(response)),
        output,
        stream,
      );

      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const doneReason =
        output.stopReason === "length" || output.stopReason === "toolUse"
          ? output.stopReason
          : "stop";
      stream.push({ type: "done", reason: doneReason, message: output });
      stream.finish(output);
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.finish(output);
    }
  })();

  return stream;
}
