import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const dataPath = join(root, "public", "data", "chunks.json");

let chunks = [];
let knowledgeDocs = [];

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

  const scored = knowledgeDocs
    .filter(({ chunk }) => !chapter || chunk.title_path.join(" / ").toLowerCase().includes(chapter))
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

const knowledgeSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "要检索的问题、关键词或改写后的查询语句。优先包含 DST Mod 中的装备名、道具名、建筑名、机制名、代码名、章节名；询问制作、来源、效果、配置、代码名时可加入对应词。",
    },
    top_k: {
      type: "number",
      description: "返回结果数量，默认 5，最大 10。",
    },
    filters: {
      type: "object",
      properties: {
        chapter: { type: "string", description: "可选，限定章节或目录。" },
        content_type: { type: "string", enum: ["text", "image", "all"] },
      },
    },
    mode: {
      type: "string",
      enum: ["keyword", "hybrid"],
      description: "检索模式。keyword 为关键词检索，hybrid 会额外使用本地 sparse-vector 召回。",
    },
    rerank: {
      type: "boolean",
      description: "是否启用轻量重排。",
    },
  },
  required: ["query"],
};

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  writeMessage({ jsonrpc: "2.0", id, result: payload });
}

function error(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  if (!message?.method) return;
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: params.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "dst-knowledge-agent", version: "0.1.0" },
    });
  }
  if (method === "tools/list") {
    return result(id, {
      tools: [
        {
          name: "knowledge_search",
          description:
            "从“饥荒联机版（Don't Starve Together, DST）英雄联盟装备 Mod”知识库中检索相关文档片段。适合查询该创意工坊 Mod 的装备、道具、建筑、制作配方、科技要求、掉落来源、主动/被动效果、耐久、修复材料、代码名、数值机制、配置项、图片说明、对比、总结和查找依据。复杂问题可以多次调用并改写 query。回答时应以 DST Mod 语境解释，不要按英雄联盟原版游戏装备来回答。",
          inputSchema: knowledgeSearchSchema,
        },
      ],
    });
  }
  if (method === "tools/call") {
    if (params.name !== "knowledge_search") return error(id, -32602, `Unknown tool: ${params.name}`);
    const payload = searchKnowledge(params.arguments || {});
    return result(id, {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    });
  }
  if (id != null) return error(id, -32601, `Unknown method: ${method}`);
}

const raw = await readFile(dataPath, "utf-8");
chunks = JSON.parse(raw);
prepareKnowledgeDocs(chunks);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line)).catch((err) => error(null, -32603, err.message));
  } catch (err) {
    error(null, -32700, err.message);
  }
});
