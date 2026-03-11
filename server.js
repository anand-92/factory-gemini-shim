import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";
const REQUEST_BODY_LIMIT_BYTES = Number(process.env.REQUEST_BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
const TOOL_CALL_CACHE_LIMIT = Number(process.env.TOOL_CALL_CACHE_LIMIT || 500);
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  "";

const OPENAI_MODELS_PATH = "https://generativelanguage.googleapis.com/v1beta/openai/models";
const GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const toolCallCache = new Map();

function log(level, message, details) {
  const timestamp = new Date().toISOString();
  if (details === undefined) {
    console[level](`[${timestamp}] ${message}`);
    return;
  }
  console[level](`[${timestamp}] ${message}`, details);
}

function json(response, statusCode, payload, extraHeaders = {}) {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message, type = "invalid_request_error") {
  json(response, statusCode, {
    error: {
      message,
      type,
    },
  });
}

function getBearerToken(request) {
  const auth = request.headers.authorization || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return auth.slice(7).trim();
}

function getApiKey(request) {
  return getBearerToken(request) || GEMINI_API_KEY;
}

function normalizeModel(model) {
  if (!model) {
    return "gemini-3.1-pro-preview";
  }
  return model.replace(/-customtools$/i, "");
}

function sha(input) {
  return createHash("sha256").update(input).digest("hex");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      callback(value);
    };

    const onError = (error) => finish(reject, error);
    const onAborted = () => finish(reject, new Error("Client closed the request before the body was fully sent."));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT_BYTES) {
        finish(reject, new Error(`Request body exceeds ${REQUEST_BODY_LIMIT_BYTES} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        finish(resolve, raw ? JSON.parse(raw) : {});
      } catch (error) {
        finish(reject, error);
      }
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function mapSchemaType(type) {
  if (!type) {
    return undefined;
  }
  const upper = String(type).toUpperCase();
  if (upper === "STRING" || upper === "NUMBER" || upper === "INTEGER" || upper === "BOOLEAN" || upper === "ARRAY" || upper === "OBJECT") {
    return upper;
  }
  return undefined;
}

function convertJsonSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }

  const result = {};
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const mappedType = mapSchemaType(type);
  if (mappedType) {
    result.type = mappedType;
  }
  if (schema.description) {
    result.description = schema.description;
  }
  if (schema.enum) {
    result.enum = schema.enum;
  }
  if (schema.items) {
    result.items = convertJsonSchema(schema.items);
  }
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      result.properties[key] = convertJsonSchema(value);
    }
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    result.required = schema.required;
  }
  return result;
}

function convertTools(tools) {
  const functionDeclarations = [];
  for (const tool of ensureArray(tools)) {
    if (tool?.type !== "function" || !tool.function?.name) {
      continue;
    }
    functionDeclarations.push({
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: convertJsonSchema(tool.function.parameters || { type: "object", properties: {} }),
    });
  }
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

function contentPartsToTextParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ text: item.text });
      continue;
    }
    if (item.type === "image_url" && typeof item.image_url?.url === "string") {
      const url = item.image_url.url;
      const dataMatch = /^data:([^;]+);base64,(.+)$/i.exec(url);
      if (dataMatch) {
        parts.push({
          inlineData: {
            mimeType: dataMatch[1],
            data: dataMatch[2],
          },
        });
      } else {
        parts.push({
          fileData: {
            mimeType: item.image_url.mime_type || "image/*",
            fileUri: url,
          },
        });
      }
      continue;
    }
  }
  return parts;
}

function getToolCallNameMap(messages) {
  const map = new Map();
  for (const message of ensureArray(messages)) {
    if (!Array.isArray(message?.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (toolCall?.id && toolCall.function?.name) {
        map.set(toolCall.id, toolCall.function.name);
      }
    }
  }
  return map;
}

function tryParseJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeFunctionResponsePayload(content) {
  const parsed = tryParseJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return { result: parsed };
}

function buildAssistantParts(message) {
  const textParts = contentPartsToTextParts(message.content);
  const functionCallParts = [];
  for (const toolCall of ensureArray(message.tool_calls)) {
    if (!toolCall?.function?.name) {
      continue;
    }
    const args = tryParseJson(toolCall.function.arguments || "{}");
    const part = {
      functionCall: {
        name: toolCall.function.name,
        args: args && typeof args === "object" ? args : {},
      },
    };
    const thoughtSignature = toolCall?.extra_content?.google?.thought_signature;
    if (thoughtSignature) {
      // Gemini REST JSON uses camelCase `thoughtSignature` on the Part.
      part.thoughtSignature = thoughtSignature;
    }
    functionCallParts.push(part);
  }
  return [...textParts, ...functionCallParts];
}

function cachedModelContentForToolCalls(toolCalls) {
  const ids = ensureArray(toolCalls).map((toolCall) => toolCall?.id).filter(Boolean);
  if (ids.length === 0) {
    return null;
  }
  const entries = ids.map((id) => toolCallCache.get(id)).filter(Boolean);
  if (entries.length !== ids.length) {
    return null;
  }
  const cacheKey = entries[0].cacheKey;
  if (!entries.every((entry) => entry.cacheKey === cacheKey)) {
    return null;
  }
  return deepClone(entries[0].modelContent);
}

function openAiMessagesToGemini(messages) {
  const contents = [];
  const systemTexts = [];
  const toolCallNames = getToolCallNameMap(messages);
  let pendingFunctionResponses = [];

  const flushPendingResponses = () => {
    if (pendingFunctionResponses.length === 0) {
      return;
    }
    contents.push({
      role: "user",
      parts: pendingFunctionResponses,
    });
    pendingFunctionResponses = [];
  };

  for (const message of ensureArray(messages)) {
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role !== "tool") {
      flushPendingResponses();
    }

    if (message.role === "system") {
      for (const part of contentPartsToTextParts(message.content)) {
        if (typeof part.text === "string" && part.text) {
          systemTexts.push(part.text);
        }
      }
      continue;
    }

    if (message.role === "user") {
      const parts = contentPartsToTextParts(message.content);
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
      continue;
    }

    if (message.role === "assistant") {
      const cached = cachedModelContentForToolCalls(message.tool_calls);
      if (cached) {
        contents.push({
          role: "model",
          parts: cached.parts || [],
        });
        continue;
      }

      const parts = buildAssistantParts(message);
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (message.role === "tool") {
      const name = toolCallNames.get(message.tool_call_id) || "tool";
      pendingFunctionResponses.push({
        functionResponse: {
          name,
          response: normalizeFunctionResponsePayload(message.content),
        },
      });
    }
  }

  flushPendingResponses();

  return {
    contents,
    systemInstruction:
      systemTexts.length > 0
        ? {
            parts: systemTexts.map((text) => ({ text })),
          }
        : undefined,
  };
}

function mapToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }
  if (toolChoice === "none") {
    return {
      functionCallingConfig: {
        mode: "NONE",
      },
    };
  }
  if (toolChoice === "required") {
    return {
      functionCallingConfig: {
        mode: "ANY",
      },
    };
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function" && toolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return undefined;
}

function openAiRequestToGemini(body) {
  const { contents, systemInstruction } = openAiMessagesToGemini(body.messages || []);
  const tools = convertTools(body.tools);
  const toolConfig = mapToolChoice(body.tool_choice);

  const requestBody = {
    contents,
  };

  if (systemInstruction) {
    requestBody.systemInstruction = systemInstruction;
  }
  if (tools) {
    requestBody.tools = tools;
  }
  if (toolConfig) {
    requestBody.toolConfig = toolConfig;
  }
  return requestBody;
}

function geminiPartsToOpenAiMessage(model, response) {
  const candidate = response?.candidates?.[0];
  const parts = ensureArray(candidate?.content?.parts);
  const textParts = [];
  const toolCalls = [];
  const modelContent = deepClone(candidate?.content || { role: "model", parts: [] });
  const cacheKey = response.responseId || sha(JSON.stringify(modelContent));

  for (const part of parts) {
    if (typeof part?.text === "string" && part.text) {
      textParts.push(part.text);
      continue;
    }
    if (part?.functionCall?.name) {
      const argsString = JSON.stringify(part.functionCall.args || {});
      const toolCallId = `call_${sha(`${cacheKey}:${part.functionCall.name}:${argsString}`).slice(0, 24)}`;
      toolCalls.push({
        id: toolCallId,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: argsString,
        },
      });
      const thoughtSignature = part.thoughtSignature || part.thought_signature;
      if (thoughtSignature) {
        toolCalls[toolCalls.length - 1].extra_content = {
          google: {
            thought_signature: thoughtSignature,
          },
        };
      }
      if (toolCallCache.size >= TOOL_CALL_CACHE_LIMIT) {
        const oldestKey = toolCallCache.keys().next().value;
        if (oldestKey) {
          toolCallCache.delete(oldestKey);
        }
      }
      toolCallCache.set(toolCallId, {
        cacheKey,
        modelContent,
      });
    }
  }

  const content = textParts.length > 0 ? textParts.join("") : null;
  return {
    role: "assistant",
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function usageFromGemini(response) {
  const usage = response?.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const completionTokens = usage.candidatesTokenCount || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokenCount || promptTokens + completionTokens,
  };
}

function finishReasonFromGemini(message, candidate) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return "tool_calls";
  }
  const reason = candidate?.finishReason || "STOP";
  if (reason === "STOP") {
    return "stop";
  }
  if (reason === "MAX_TOKENS") {
    return "length";
  }
  return "stop";
}

function toOpenAiCompletion(model, requestBody, geminiResponse) {
  const candidate = geminiResponse?.candidates?.[0] || {};
  const message = geminiPartsToOpenAiMessage(model, geminiResponse);
  return {
    id: geminiResponse.responseId || `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFromGemini(message, candidate),
      },
    ],
    usage: usageFromGemini(geminiResponse),
  };
}

function writeSseChunk(response, payload) {
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function toOpenAiStream(response, completion) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });

  const choice = completion.choices[0];
  const firstDelta = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(choice.message.content ? { content: choice.message.content } : {}),
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
        finish_reason: null,
      },
    ],
  };
  writeSseChunk(response, firstDelta);

  const finalChunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: choice.finish_reason,
      },
    ],
    usage: completion.usage,
  };
  writeSseChunk(response, finalChunk);
  response.end("data: [DONE]\n\n");
}

async function fetchGeminiNative(model, apiKey, body) {
  const url = `${GEMINI_NATIVE_BASE}/${encodeURIComponent(normalizeModel(model))}:generateContent`;
  const response = await fetchUpstream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  return parseJsonResponse(response);
}

async function fetchUpstream(url, options = {}) {
  let signal = options.signal;
  if (!signal && typeof AbortSignal?.timeout === "function") {
    signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  }

  try {
    return await fetch(url, {
      ...options,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms.`);
    }
    throw error;
  }
}

async function relayUpstreamResponse(response, upstream) {
  const text = await upstream.text();
  if (response.writableEnded) {
    return;
  }
  response.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(text);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Upstream returned invalid JSON.");
  }
}

async function proxyModels(request, response) {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    sendError(response, 401, "Missing Gemini API key. Set GEMINI_API_KEY or send Authorization: Bearer <key>.");
    return;
  }

  const upstream = await fetchUpstream(OPENAI_MODELS_PATH, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  await relayUpstreamResponse(response, upstream);
}

async function proxyModelRetrieve(request, response, pathname) {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    sendError(response, 401, "Missing Gemini API key. Set GEMINI_API_KEY or send Authorization: Bearer <key>.");
    return;
  }

  const upstream = await fetchUpstream(`https://generativelanguage.googleapis.com/v1beta/openai${pathname}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  await relayUpstreamResponse(response, upstream);
}

async function handleChatCompletions(request, response) {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    sendError(response, 401, "Missing Gemini API key. Set GEMINI_API_KEY or send Authorization: Bearer <key>.");
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON request body.";
    const statusCode =
      typeof message === "string" && message.startsWith("Request body exceeds")
        ? 413
        : message === "Client closed the request before the body was fully sent."
          ? 499
          : 400;
    sendError(response, statusCode, message);
    return;
  }

  if (!body?.model) {
    sendError(response, 400, "Missing required field: model.");
    return;
  }

  try {
    const geminiRequest = openAiRequestToGemini(body);
    const geminiResponse = await fetchGeminiNative(body.model, apiKey, geminiRequest);
    const completion = toOpenAiCompletion(body.model, body, geminiResponse);

    if (body.stream) {
      toOpenAiStream(response, completion);
      return;
    }

    json(response, 200, completion);
  } catch (error) {
    sendError(response, 500, error instanceof Error ? error.message : "Proxy request failed.");
  }
}

async function handleRequest(request, response) {
  if (!request.url) {
    sendError(response, 404, "Not found.");
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      ok: true,
      port: PORT,
      proxy: "factory-gemini-shim",
    });
    return;
  }

  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    await proxyModels(request, response);
    return;
  }

  if (request.method === "GET" && /^\/v1\/models\/[^/]+$/.test(url.pathname)) {
    await proxyModelRetrieve(request, response, url.pathname);
    return;
  }

  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    await handleChatCompletions(request, response);
    return;
  }

  sendError(response, 404, `No route for ${request.method} ${url.pathname}.`, "not_found_error");
}

const server = http.createServer((request, response) => {
  response.on("error", (error) => {
    log("error", "Response stream error.", error);
  });

  handleRequest(request, response).catch((error) => {
    log("error", `Unhandled request error for ${request.method || "UNKNOWN"} ${request.url || ""}.`, error);
    if (!response.writableEnded) {
      sendError(response, 500, error instanceof Error ? error.message : "Internal server error.");
    }
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 120000;

server.on("clientError", (error, socket) => {
  log("warn", "Client connection error.", error.message);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception.", error);
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection.", reason);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("log", `Received ${signal}, shutting down.`);
    server.close(() => {
      process.exit(0);
    });
  });
}

server.listen(PORT, HOST, () => {
  log("log", `factory-gemini-shim listening on http://${HOST}:${PORT}`);
});
