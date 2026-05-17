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

function tokenize(input) {
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
  return [...new Set([...phrases, ...latin, ...cjk])].slice(0, 80);
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

function searchKnowledge({ query, top_k = 5, filters = {} }) {
  const terms = tokenize(query);
  const limit = Math.max(1, Math.min(Number(top_k) || 5, 10));
  const chapter = String(filters?.chapter || "").trim().toLowerCase();
  if (!terms.length && String(query || "").trim()) {
    return { query, mode: "keyword", results: [] };
  }

  const scored = chunks
    .filter((chunk) => {
      if (!chapter) return true;
      return chunk.title_path.join(" / ").toLowerCase().includes(chapter);
    })
    .map((chunk) => {
      const title = `${chunk.title} ${chunk.title_path.join(" ")}`.toLowerCase();
      const body = String(chunk.content || "").toLowerCase();
      let score = 0;
      const highlights = [];
      for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const titleHits = (title.match(new RegExp(escaped, "g")) || []).length;
        const bodyHits = (body.match(new RegExp(escaped, "g")) || []).length;
        if (titleHits || bodyHits) highlights.push(term);
        score += titleHits * 24 + bodyHits * 3;
      }
      const exactQuery = String(query || "").trim().toLowerCase();
      if (exactQuery && title.includes(exactQuery)) score += 120;
      if (exactQuery && body.includes(exactQuery)) score += 12;
      return { chunk, score, highlights: [...new Set(highlights)] };
    })
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    mode: "keyword",
    results: scored.map(({ chunk, score, highlights }) => ({
      chunk_id: chunk.chunk_id,
      title: chunk.title,
      title_path: chunk.title_path,
      content: makeSnippet(chunk.content, highlights.length ? highlights : terms),
      score,
      source: {
        doc: chunk.source_doc,
        anchor: chunk.anchor,
      },
      images: chunk.images || [],
      highlights,
    })),
  };
}

function normalizeQuestionForSearch(question) {
  return String(question || "")
    .replace(/[?？!！。]/g, " ")
    .replace(/(有什么|有哪些|什么是|是什么|怎么|如何|多少|介绍一下|说一下|效果|属性|作用|机制)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function buildPrompt(question, results, webResults = []) {
  const context = results
    .map((item, index) => {
      const path = item.title_path.join(" / ");
      return `[${index + 1}] ${path}\n${item.content}`;
    })
    .join("\n\n");
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
        "你是一个知识库问答助手。优先基于知识库片段回答；如果提供了联网搜索结果，可以作为补充信息。资料不足时明确说明未找到依据。回答要简洁，并在相关结论后标注来源编号，知识库来源用 [1]，联网来源用 [W1]。",
    },
    {
      role: "user",
      content: `问题：${question}\n\n知识库片段：\n${context || "未检索到相关资料"}\n\n联网搜索结果：\n${webContext || "未启用或未检索到联网资料"}`,
    },
  ];
}

function buildResponsesInput(question, results, webResults = []) {
  return buildPrompt(question, results, webResults)
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

async function readChatCompletionResponse(response, streaming) {
  if (!streaming) {
    const data = await response.json();
    return {
      answer: data.choices?.[0]?.message?.content || "",
      usage: data.usage || null,
    };
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let answer = "";
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) answer += delta.content;
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // Ignore malformed stream fragments and continue reading.
      }
    }
  }

  return { answer, usage };
}

function readResponsesText(data) {
  if (data.output_text) return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("");
}

function stripReasoningTags(answer) {
  return String(answer || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
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

async function callOpenAICompatible(question, searchResults, llmConfig = {}, webResults = []) {
  const modelConfig = resolveModelConfig(llmConfig);
  if (!modelConfig?.endpointUrl || !modelConfig?.apiKey) return null;

  const isResponsesApi = modelConfig.apiType === "responses";
  const outputLimit = Math.max(16, Math.min(Number(llmConfig.max_tokens) || 900, 1200));
  const payload = isResponsesApi
    ? {
        model: modelConfig.model,
        input: buildResponsesInput(question, searchResults, webResults),
        max_output_tokens: outputLimit,
        ...(modelConfig.requestOptions || {}),
      }
    : {
        model: modelConfig.model,
        messages: buildPrompt(question, searchResults, webResults),
        max_tokens: outputLimit,
        ...(modelConfig.requestOptions || {}),
      };
  if (!payload.thinking?.type || payload.thinking.type !== "enabled") {
    payload.temperature = 0.2;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(10_000, Math.min(Number(modelConfig.requestTimeoutMs) || 45_000, 180_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(modelConfig.endpointUrl, {
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
    const data = isResponsesApi
      ? await response.json().then((value) => ({
          answer: readResponsesText(value),
          usage: value.usage || null,
        }))
      : await readChatCompletionResponse(response, Boolean(payload.stream));
    return {
      answer: stripReasoningTags(data.answer),
      model: modelConfig.id,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackAnswer(question, results, webResults = []) {
  if (!results.length && !webResults.length) {
    return `未在知识库中检索到与“${question}”直接相关的内容。可以换用文档中的装备名、章节名或具体关键词再试。`;
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
    const body = await readJsonBody(req);
    return sendJson(res, 200, searchKnowledge(body));
  }

  if (url.pathname === "/api/models/test" && req.method === "POST") {
    const rate = checkRateLimit(req, "models-test", { limit: 6, windowMs: 60_000 });
    if (!rate.allowed) return sendJson(res, 429, { error: "rate limit exceeded", retry_after: rate.retryAfterSeconds });
    const body = await readJsonBody(req);
    const started = Date.now();
    try {
      const result = await callOpenAICompatible("请只回复 OK。", [], {
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
    const searchQuery = normalizeQuestionForSearch(question) || question;
    const search = searchKnowledge({ query: searchQuery, top_k: body.top_k || 5 });
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
        return sendJson(res, 502, { error: error.message, search_results: search.results });
      }
    }
    let llmResult;
    try {
      llmResult = await callOpenAICompatible(question, search.results, body.llm_config, webResults);
    } catch (error) {
      logEvent("chat", {
        ip: clientIp(req),
        ok: false,
        model_id: body.llm_config?.model_id || "custom",
        question_length: question.length,
        results: search.results.length,
        web_results: webResults.length,
        duration_ms: Date.now() - started,
        error: error.message,
      });
      return sendJson(res, 502, { error: error.message, search_results: search.results });
    }
    const answer = llmResult?.answer || fallbackAnswer(question, search.results, webResults);
    logEvent("chat", {
      ip: clientIp(req),
      ok: true,
      model_id: llmResult?.model || body.llm_config?.model_id || "fallback",
      question_length: question.length,
      results: search.results.length,
      web_results: webResults.length,
      duration_ms: Date.now() - started,
      prompt_tokens: llmResult?.usage?.prompt_tokens,
      completion_tokens: llmResult?.usage?.completion_tokens,
    });

    return sendJson(res, 200, {
      answer,
      model_id: llmResult?.model || body.llm_config?.model_id || null,
      citations: search.results.map((item) => ({
        chunk_id: item.chunk_id,
        title: item.title,
        anchor: item.source.anchor,
      })),
      search_results: search.results.map((item) => ({
        chunk_id: item.chunk_id,
        score: item.score,
      })),
      web_results: webResults.map((item, index) => ({
        id: `W${index + 1}`,
        title: item.title,
        url: item.url,
        score: item.score,
      })),
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
