import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const publicDir = join(root, "public");
const dataPath = join(publicDir, "data", "chunks.json");
const modelsPath = join(root, "server", "models.local.json");
const port = Number(process.env.PORT || 3000);

let chunks = [];
let knowledgeDocs = [];
let serverModels = [];
const rateBuckets = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function tokenize(input, maxTerms = 80) {
  const normalized = String(input || "").toLowerCase();
  const latin = normalized.match(/[a-z0-9_+-]{2,}/g) || [];
  const cjkText = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  const cjk =
    cjkText.length > 1
      ? [
          cjkText,
          ...Array.from({ length: Math.max(0, cjkText.length - 1) }, (_, index) =>
            cjkText.slice(index, index + 2),
          ),
        ]
      : cjkText
        ? [cjkText]
        : [];
  const phrases = normalized
    .split(/[\s,，.。;；:：!?！？、"'“”‘’()[\]{}<>《》/\\|-]+/)
    .filter((part) => part.length >= 2);
  return [...new Set([...phrases, ...latin, ...cjk])].slice(0, maxTerms);
}

function buildTermVector(terms) {
  const vector = new Map();
  for (const term of terms) vector.set(term, (vector.get(term) || 0) + 1);
  let norm = 0;
  for (const count of vector.values()) norm += count * count;
  return { vector, norm: Math.sqrt(norm) || 1 };
}

function cosineSimilarity(queryVector, docVector, docNorm) {
  let dot = 0;
  for (const [term, count] of queryVector.vector.entries()) {
    dot += count * (docVector.get(term) || 0);
  }
  return dot / (queryVector.norm * docNorm || 1);
}

function prepareKnowledgeDocs(items) {
  knowledgeDocs = items.map((chunk) => {
    const titleText = `${chunk.title} ${chunk.title_path.join(" ")}`.toLowerCase();
    const bodyText = String(chunk.content || "").toLowerCase();
    const terms = tokenize(`${titleText} ${bodyText}`, 800);
    const { vector, norm } = buildTermVector(terms);
    return { chunk, titleText, bodyText, vector, norm };
  });
}

function makeSnippet(content, terms) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((pos) => pos >= 0)
    .sort((a, b) => a - b)[0];
  if (index == null) return text.slice(0, 520);
  const start = Math.max(0, index - 90);
  const end = Math.min(text.length, index + 430);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function searchKnowledge({ query, top_k = 5, filters = {}, mode = "keyword", rerank = false }) {
  const terms = tokenize(query);
  const limit = Math.max(1, Math.min(Number(top_k) || 5, 10));
  const searchMode = mode === "hybrid" ? "hybrid" : "keyword";
  const chapter = String(filters?.chapter || "").trim().toLowerCase();
  const contentType = String(filters?.content_type || "all").toLowerCase();
  const exactQuery = String(query || "").trim().toLowerCase();
  const queryVector = buildTermVector(terms);
  if (!terms.length && String(query || "").trim()) {
    return { query, mode: searchMode, results: [] };
  }

  const docs = knowledgeDocs.length ? knowledgeDocs : chunks.map((chunk) => {
    const titleText = `${chunk.title} ${chunk.title_path.join(" ")}`.toLowerCase();
    const bodyText = String(chunk.content || "").toLowerCase();
    const vector = buildTermVector(tokenize(`${titleText} ${bodyText}`, 800));
    return { chunk, titleText, bodyText, vector: vector.vector, norm: vector.norm };
  });

  const scored = docs
    .filter(({ chunk }) => {
      if (!chapter) return true;
      return chunk.title_path.join(" / ").toLowerCase().includes(chapter);
    })
    .filter(({ chunk }) => {
      if (contentType === "image") return Boolean(chunk.images?.length);
      if (contentType === "text") return Boolean(String(chunk.content || "").trim());
      return true;
    })
    .map((doc) => {
      const { chunk, titleText, bodyText } = doc;
      let keywordScore = 0;
      const highlights = [];
      for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const titleHits = (titleText.match(new RegExp(escaped, "g")) || []).length;
        const bodyHits = (bodyText.match(new RegExp(escaped, "g")) || []).length;
        if (titleHits || bodyHits) highlights.push(term);
        keywordScore += titleHits * 24 + bodyHits * 3;
      }
      if (exactQuery && titleText.includes(exactQuery)) keywordScore += 120;
      if (exactQuery && bodyText.includes(exactQuery)) keywordScore += 12;
      const vectorScore = searchMode === "hybrid" ? cosineSimilarity(queryVector, doc.vector, doc.norm) : 0;
      let score = keywordScore + vectorScore * 80;
      if (rerank) {
        if (exactQuery && chunk.title.toLowerCase() === exactQuery) score += 160;
        if (exactQuery && chunk.title_path.join(" / ").toLowerCase().includes(exactQuery)) score += 60;
        if (chunk.images?.length) score += 2;
      }
      return {
        chunk,
        score,
        highlights: [...new Set(highlights)],
        score_details: {
          keyword: Number(keywordScore.toFixed(4)),
          vector: Number(vectorScore.toFixed(4)),
        },
      };
    })
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    mode: searchMode,
    rerank: Boolean(rerank),
    results: scored.map(({ chunk, score, highlights, score_details }) => ({
      chunk_id: chunk.chunk_id,
      title: chunk.title,
      title_path: chunk.title_path,
      content: makeSnippet(chunk.content, highlights.length ? highlights : terms),
      score: Number(score.toFixed(4)),
      score_details,
      source: {
        doc: chunk.source_doc,
        anchor: chunk.anchor,
      },
      images: chunk.images || [],
      highlights,
    })),
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function checkRateLimit(req, scope, { limit = 10, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function logEvent(type, fields = {}) {
  const safe = { ...fields };
  delete safe.apiKey;
  delete safe.tavilyApiKey;
  delete safe.authorization;
  console.log(JSON.stringify({ ts: new Date().toISOString(), type, ...safe }));
}

async function readJsonBody(req) {
  let body = "";
  for await (const part of req) body += part;
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(value));
}

const knowledgeSearchTool = {
  type: "function",
  function: {
    name: "knowledge_search",
    description:
      "从当前知识库中检索与用户问题相关的文档片段。适合查询装备、术语、规则、配置、更新计划、图片说明、对比、总结和查找依据。复杂问题可以多次调用，分别检索核心名词、对比对象或限制条件。返回标题、目录路径、正文片段、图片、来源锚点和相关性分数。最终回答应基于返回 results，不要把未检索到的内容当成事实。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要检索的问题、关键词或改写后的查询语句。尽量包含核心名词。",
        },
        top_k: {
          type: "number",
          description: "返回结果数量，默认 5，最大 10。",
        },
        filters: {
          type: "object",
          properties: {
            chapter: { type: "string", description: "可选，限定章节或目录。" },
            content_type: {
              type: "string",
              enum: ["text", "image", "all"],
              description: "可选，内容类型过滤。",
            },
          },
        },
        mode: {
          type: "string",
          enum: ["keyword", "hybrid"],
          description: "检索模式。keyword 为关键词检索，hybrid 会额外使用本地 sparse-vector 召回。",
        },
        rerank: {
          type: "boolean",
          description: "是否启用轻量重排。复杂对比、总结或标题精确匹配问题可设为 true。",
        },
      },
      required: ["query"],
    },
  },
};

function buildAgentMessages(question, webResults = []) {
  const webContext = webResults
    .map((item, index) => {
      const title = item.title || item.url || `网页结果 ${index + 1}`;
      return `[W${index + 1}] ${title}\nURL: ${item.url}\n${item.content || ""}`;
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "你是一个知识库问答助手。你可以调用 knowledge_search 工具查询知识库，但不要无条件检索。只有当问题涉及知识库资料、文档内容、装备、规则、配置、更新计划、图片说明、对比、总结或需要依据时才调用。闲聊、纯格式要求、与知识库无关的问题可以直接回答。复杂问题可多次调用 knowledge_search 并改写 query。回答要简洁；基于知识库结果时引用 [K1]、[K2]，基于联网结果时引用 [W1]；资料不足时说明未找到明确依据。",
    },
    {
      role: "user",
      content: `问题：${question}\n\n联网搜索结果：\n${webContext || "未启用或未检索到联网资料"}`,
    },
  ];
}

function buildResponsesInput(question, webResults = []) {
  return buildAgentMessages(question, webResults)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

function publicModels() {
  return serverModels.map(({ id, label, provider, model, features = [] }) => ({
    id,
    label,
    provider,
    model,
    features,
  }));
}

function findServerModel(modelId) {
  return serverModels.find((item) => item.id === modelId) || serverModels[0] || null;
}

function normalizeCustomConfig(llmConfig = {}) {
  const apiBaseUrl = (llmConfig.apiBaseUrl || process.env.LLM_API_BASE_URL || "").replace(/\/$/, "");
  return {
    id: "custom",
    label: "用户自定义模型",
    provider: "custom",
    endpointUrl: apiBaseUrl ? `${apiBaseUrl}/chat/completions` : "",
    apiKey: llmConfig.apiKey || process.env.LLM_API_KEY || "",
    model: llmConfig.model || process.env.LLM_MODEL || "gpt-4o-mini",
    requestOptions: {},
  };
}

function resolveModelConfig(llmConfig = {}) {
  if (llmConfig.provider === "custom") return normalizeCustomConfig(llmConfig);
  if (llmConfig.model_id) return findServerModel(llmConfig.model_id);
  return findServerModel(process.env.DEFAULT_MODEL_ID);
}

async function readChatCompletionJson(response) {
  const data = await response.json();
  return {
    message: data.choices?.[0]?.message || { role: "assistant", content: "" },
    usage: data.usage || null,
  };
}

function readResponsesText(data) {
  if (data.output_text) return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (!candidate.trim()) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function stripReasoningTags(answer) {
  return String(answer || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function normalizeToolSearchArgs(rawArgs) {
  let parsed = {};
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    parsed = { query: String(rawArgs || "") };
  }
  return {
    query: String(parsed.query || "").slice(0, 500),
    top_k: Math.max(1, Math.min(Number(parsed.top_k) || 5, 10)),
    filters: parsed.filters && typeof parsed.filters === "object" ? parsed.filters : {},
    mode: parsed.mode === "hybrid" ? "hybrid" : "keyword",
    rerank: Boolean(parsed.rerank),
  };
}

function compactKnowledgeResult(searchResult) {
  return {
    query: searchResult.query,
    mode: searchResult.mode,
    results: searchResult.results.map((item, index) => ({
      ref: `K${index + 1}`,
      chunk_id: item.chunk_id,
      title: item.title,
      title_path: item.title_path,
      content: item.content,
      score: item.score,
      score_details: item.score_details,
      source: item.source,
      images: item.images,
      highlights: item.highlights,
    })),
  };
}

function formatKnowledgeContext(results) {
  return results
    .map((item, index) => {
      const path = item.title_path.join(" / ");
      return `[K${index + 1}] ${path}\n${item.content}\n来源：${item.source.anchor}`;
    })
    .join("\n\n");
}

function mergeKnowledgeResults(previous, next) {
  const seen = new Set(previous.map((item) => item.chunk_id));
  const merged = [...previous];
  for (const item of next) {
    if (seen.has(item.chunk_id)) continue;
    seen.add(item.chunk_id);
    merged.push(item);
  }
  return merged.slice(0, 10);
}

async function callTavilySearch(question, webConfig = {}) {
  if (!webConfig?.enabled || webConfig.provider !== "tavily" || !webConfig.apiKey) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${webConfig.apiKey}`,
      },
      body: JSON.stringify({
        query: question,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tavily request failed: ${response.status} ${text.slice(0, 160)}`);
    }
    const data = await response.json();
    const answerResult = data.answer
      ? [
          {
            title: "Tavily answer",
            url: "https://tavily.com",
            content: data.answer,
            score: 1,
          },
        ]
      : [];
    const results = Array.isArray(data.results)
      ? data.results.map((item) => ({
          title: item.title || "",
          url: item.url || "",
          content: item.content || "",
          score: item.score || 0,
        }))
      : [];
    return [...answerResult, ...results].slice(0, 5);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModelJson(modelConfig, payload) {
  const controller = new AbortController();
  const timeoutMs = Math.max(10_000, Math.min(Number(modelConfig.requestTimeoutMs) || 45_000, 180_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(modelConfig.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${modelConfig.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAICompatible(question, llmConfig = {}, webResults = [], options = {}) {
  const modelConfig = resolveModelConfig(llmConfig);
  if (!modelConfig?.endpointUrl || !modelConfig?.apiKey) return null;

  const isResponsesApi = modelConfig.apiType === "responses";
  const outputLimit = Math.max(16, Math.min(Number(llmConfig.max_tokens) || 900, 1200));
  const enableKnowledgeTool = options.enableKnowledgeTool !== false;

  if (isResponsesApi) {
    const plannerPayload = {
      model: modelConfig.model,
      input: [
        "你是知识库 Agent 的工具调用规划器。判断是否需要查询知识库。",
        "如果问题涉及文档内容、装备、规则、配置、更新计划、图片说明、对比、总结或需要依据，返回 knowledge_search。",
        "如果是闲聊、格式要求或与知识库无关的问题，直接回答。",
        "只输出 JSON，不要输出 markdown。",
        '格式一：{"action":"knowledge_search","queries":[{"query":"关键词","top_k":5,"mode":"hybrid","rerank":true}]}',
        '格式二：{"action":"answer","answer":"直接回答内容"}',
        `用户问题：${question}`,
      ].join("\n"),
      max_output_tokens: Math.min(outputLimit, 500),
      ...(modelConfig.requestOptions || {}),
    };
    if (!plannerPayload.thinking?.type || plannerPayload.thinking.type !== "enabled") {
      plannerPayload.temperature = 0.2;
    }
    const plannerResponse = await fetchModelJson(modelConfig, plannerPayload);
    const plannerData = await plannerResponse.json().then((value) => ({
      answer: stripReasoningTags(readResponsesText(value)),
      usage: value.usage || null,
    }));
    const plan = extractJsonObject(plannerData.answer);
    let usage = plannerData.usage || null;
    let knowledgeResults = [];
    const toolCalls = [];

    if (plan?.action === "knowledge_search") {
      const queries = Array.isArray(plan.queries) ? plan.queries.slice(0, 4) : [];
      for (const queryPlan of queries) {
        const args = normalizeToolSearchArgs(JSON.stringify(queryPlan));
        const result = searchKnowledge(args);
        knowledgeResults = mergeKnowledgeResults(knowledgeResults, result.results);
        toolCalls.push({
          name: "knowledge_search",
          arguments: args,
          result_count: result.results.length,
          top_chunk_ids: result.results.slice(0, 5).map((item) => item.chunk_id),
        });
      }

      const finalPayload = {
        model: modelConfig.model,
        input: [
          buildResponsesInput(question, webResults),
          "知识库工具结果：",
          formatKnowledgeContext(knowledgeResults) || "未检索到相关知识库资料。",
          "请基于上述工具结果回答。使用知识库资料时引用 [K1]、[K2]；资料不足时明确说明。",
        ].join("\n\n"),
        max_output_tokens: outputLimit,
        ...(modelConfig.requestOptions || {}),
      };
      if (!finalPayload.thinking?.type || finalPayload.thinking.type !== "enabled") {
        finalPayload.temperature = 0.2;
      }
      const finalResponse = await fetchModelJson(modelConfig, finalPayload);
      const finalData = await finalResponse.json().then((value) => ({
        answer: readResponsesText(value),
        usage: value.usage || null,
      }));
      usage = finalData.usage || usage;
      return {
        answer: stripReasoningTags(finalData.answer),
        model: modelConfig.id,
        usage,
        knowledgeResults,
        agentTrace: {
          mode: "responses_tool_protocol",
          tool_calls: toolCalls,
        },
      };
    }

    return {
      answer: stripReasoningTags(plan?.answer || plannerData.answer),
      model: modelConfig.id,
      usage,
      knowledgeResults: [],
      agentTrace: {
        mode: "responses_tool_protocol",
        tool_calls: [],
      },
    };
  }

  const messages = buildAgentMessages(question, webResults);
  const toolCalls = [];
  let usage = null;
  let knowledgeResults = [];

  for (let step = 0; step < 4; step += 1) {
    const payload = {
      model: modelConfig.model,
      messages,
      max_tokens: outputLimit,
      ...(modelConfig.requestOptions || {}),
    };
    if (enableKnowledgeTool) {
      payload.tools = [knowledgeSearchTool];
      payload.tool_choice = "auto";
    }
    if (!payload.thinking?.type || payload.thinking.type !== "enabled") {
      payload.temperature = 0.2;
    }

    const response = await fetchModelJson(modelConfig, payload);
    const data = await readChatCompletionJson(response);
    usage = data.usage || usage;
    const message = data.message || { role: "assistant", content: "" };
    const requestedTools = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (!requestedTools.length) {
      return {
        answer: stripReasoningTags(message.content || ""),
        model: modelConfig.id,
        usage,
        knowledgeResults,
        agentTrace: {
          mode: enableKnowledgeTool ? "tool_calling" : "direct",
          tool_calls: toolCalls,
        },
      };
    }

    const assistantToolMessage = {
      ...message,
      role: "assistant",
      content: message.content ?? "",
      tool_calls: requestedTools,
    };
    messages.push(assistantToolMessage);

    for (const toolCall of requestedTools) {
      const toolName = toolCall.function?.name;
      if (toolName !== "knowledge_search") continue;
      const args = normalizeToolSearchArgs(toolCall.function?.arguments);
      const result = searchKnowledge(args);
      const compact = compactKnowledgeResult(result);
      knowledgeResults = mergeKnowledgeResults(knowledgeResults, result.results);
      toolCalls.push({
        name: toolName,
        arguments: args,
        result_count: result.results.length,
        top_chunk_ids: result.results.slice(0, 5).map((item) => item.chunk_id),
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(compact),
      });
    }
  }

  const finalPayload = {
    model: modelConfig.model,
    messages: [
      ...messages,
      {
        role: "user",
        content: "请基于已有对话和工具结果直接给出最终答案；如果资料不足，请明确说明。",
      },
    ],
    max_tokens: outputLimit,
    ...(modelConfig.requestOptions || {}),
  };
  if (!finalPayload.thinking?.type || finalPayload.thinking.type !== "enabled") {
    finalPayload.temperature = 0.2;
  }
  const response = await fetchModelJson(modelConfig, finalPayload);
  const data = await readChatCompletionJson(response);
  return {
    answer: stripReasoningTags(data.message?.content || ""),
    model: modelConfig.id,
    usage: data.usage || usage,
    knowledgeResults,
    agentTrace: {
      mode: "tool_calling",
      tool_calls: toolCalls,
      stopped_after_max_tool_rounds: true,
    },
  };
}

function fallbackAnswer(question, results = [], webResults = []) {
  if (!results.length && !webResults.length) {
    return `当前未配置可用 LLM，Agent 无法自主调用 knowledge_search。请先在 LLM 配置中选择后端模型或添加自定义模型后再试。`;
  }
  const lines = results.slice(0, 3).map((item, index) => {
    const path = item.title_path.join(" / ");
    return `${index + 1}. ${path}：${item.content}`;
  });
  const webLines = webResults.slice(0, 3).map((item, index) => {
    return `W${index + 1}. ${item.title || item.url}\n${item.url}\n${item.content}`;
  });
  return `以下是检索到的相关内容摘要：\n\n${[...lines, ...webLines].join("\n\n")}\n\n当前未配置默认 LLM，因此返回检索式摘要。配置模型后可生成完整回答。`;
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, chunks: chunks.length });
  if (url.pathname === "/api/models" && req.method === "GET") {
    return sendJson(res, 200, { models: publicModels(), default_model_id: serverModels[0]?.id || null });
  }

  if (url.pathname === "/api/knowledge/search" && req.method === "POST") {
    const rate = checkRateLimit(req, "knowledge-search", { limit: 60, windowMs: 60_000 });
    if (!rate.allowed) return sendJson(res, 429, { error: "rate limit exceeded", retry_after: rate.retryAfterSeconds });
    const body = await readJsonBody(req);
    const started = Date.now();
    const result = searchKnowledge(body);
    logEvent("knowledge_search", {
      ip: clientIp(req),
      query_length: String(body.query || "").length,
      mode: result.mode,
      rerank: result.rerank,
      results: result.results.length,
      duration_ms: Date.now() - started,
    });
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/models/test" && req.method === "POST") {
    const rate = checkRateLimit(req, "models-test", { limit: 6, windowMs: 60_000 });
    if (!rate.allowed) return sendJson(res, 429, { error: "rate limit exceeded", retry_after: rate.retryAfterSeconds });
    const body = await readJsonBody(req);
    const started = Date.now();
    try {
      const result = await callOpenAICompatible("请只回复 OK。", {
        provider: "server_model",
        model_id: body.model_id,
        max_tokens: 32,
      });
      logEvent("model_test", {
        ip: clientIp(req),
        model_id: body.model_id,
        ok: Boolean(result?.answer),
        duration_ms: Date.now() - started,
      });
      return sendJson(res, 200, { ok: Boolean(result?.answer), model_id: body.model_id, answer: result?.answer || "" });
    } catch (error) {
      logEvent("model_test", {
        ip: clientIp(req),
        model_id: body.model_id,
        ok: false,
        duration_ms: Date.now() - started,
        error: error.message,
      });
      return sendJson(res, 502, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    const rate = checkRateLimit(req, "chat", { limit: 10, windowMs: 60_000 });
    if (!rate.allowed) return sendJson(res, 429, { error: "rate limit exceeded", retry_after: rate.retryAfterSeconds });

    const body = await readJsonBody(req);
    const question = String(body.question || "").trim().slice(0, 1000);
    if (!question) return sendJson(res, 400, { error: "question is required" });

    const started = Date.now();
    let webResults = [];
    if (body.web_search?.enabled) {
      const webRate = checkRateLimit(req, "tavily", { limit: 10, windowMs: 60_000 });
      if (!webRate.allowed) {
        return sendJson(res, 429, { error: "web search rate limit exceeded", retry_after: webRate.retryAfterSeconds });
      }
      try {
        webResults = await callTavilySearch(question, body.web_search);
      } catch (error) {
        logEvent("tavily_search", {
          ip: clientIp(req),
          ok: false,
          duration_ms: Date.now() - started,
          error: error.message,
        });
        return sendJson(res, 502, { error: error.message, search_results: [] });
      }
    }
    let llmResult;
    try {
      llmResult = await callOpenAICompatible(question, body.llm_config, webResults);
    } catch (error) {
      logEvent("chat", {
        ip: clientIp(req),
        ok: false,
        model_id: body.llm_config?.model_id || "custom",
        question_length: question.length,
        results: 0,
        knowledge_tool_calls: 0,
        web_results: webResults.length,
        duration_ms: Date.now() - started,
        error: error.message,
      });
      return sendJson(res, 502, { error: error.message, search_results: [] });
    }
    const knowledgeResults = llmResult?.knowledgeResults || [];
    const answer = llmResult?.answer || fallbackAnswer(question, knowledgeResults, webResults);
    const agentTrace = llmResult?.agentTrace || { mode: "fallback_no_llm", tool_calls: [] };
    logEvent("chat", {
      ip: clientIp(req),
      ok: true,
      model_id: llmResult?.model || body.llm_config?.model_id || "fallback",
      question_length: question.length,
      results: knowledgeResults.length,
      knowledge_tool_calls: agentTrace.tool_calls?.length || 0,
      web_results: webResults.length,
      duration_ms: Date.now() - started,
      prompt_tokens: llmResult?.usage?.prompt_tokens,
      completion_tokens: llmResult?.usage?.completion_tokens,
    });

    return sendJson(res, 200, {
      answer,
      model_id: llmResult?.model || body.llm_config?.model_id || null,
      citations: knowledgeResults.map((item) => ({
        chunk_id: item.chunk_id,
        title: item.title,
        anchor: item.source.anchor,
      })),
      search_results: knowledgeResults.map((item) => ({
        chunk_id: item.chunk_id,
        score: item.score,
      })),
      web_results: webResults.map((item, index) => ({
        id: `W${index + 1}`,
        title: item.title,
        url: item.url,
        score: item.score,
      })),
      agent_trace: agentTrace,
    });
  }

  return sendJson(res, 404, { error: "not found" });
}

async function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

async function loadData() {
  const raw = await readFile(dataPath, "utf-8");
  chunks = JSON.parse(raw);
  prepareKnowledgeDocs(chunks);
  if (existsSync(modelsPath)) {
    const modelRaw = await readFile(modelsPath, "utf-8");
    serverModels = JSON.parse(modelRaw).filter((item) => item.id && item.endpointUrl && item.apiKey && item.model);
  } else if (process.env.LLM_API_BASE_URL && process.env.LLM_API_KEY) {
    serverModels = [
      {
        id: "server-default",
        label: process.env.LLM_MODEL || "Server Default",
        provider: "openai-compatible",
        endpointUrl: `${process.env.LLM_API_BASE_URL.replace(/\/$/, "")}/chat/completions`,
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL || "gpt-4o-mini",
        features: [],
        requestOptions: {},
      },
    ];
  }
}

await loadData();

createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => sendJson(res, 500, { error: error.message }));
  } else {
    serveStatic(req, res, url).catch((error) => {
      res.writeHead(500);
      res.end(error.message);
    });
  }
}).listen(port, () => {
  console.log(`Knowledge Agent MVP running at http://localhost:${port}`);
});
