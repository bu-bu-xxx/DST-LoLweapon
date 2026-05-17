# 知识库网页与 Agent 后端设计方案

## 1. 项目目标

基于工作目录中的 Word/docx 数据资源，构建一个在线知识库网站，让用户可以：

- 在线阅读文档内容，包括分级目录、正文和图片。
- 按关键词搜索知识库内容。
- 在网页中通过小弹窗向 Agent 提问。
- 让 Agent 基于知识库内容回答，并给出来源引用。
- 支持站点提供默认 LLM 接入，也支持用户自行输入 API URL、API Key、模型名等配置。

本项目优先采用轻量、低成本、易维护的方案：

- 前端优先静态化，适合部署到 GitHub Pages。
- Agent 后端部署到轻量级服务器。
- 检索能力设计成独立 tool/API，先实现关键词检索，后续扩展向量检索和 rerank。

## 2. 总体架构

```text
Word/docx 数据资源
  ↓
文档解析与切片脚本
  ↓
结构化知识库数据
  ├─ Markdown/JSON 正文
  ├─ 图片资源
  ├─ 目录树
  └─ 检索索引
  ↓
前端静态网站
  ├─ 在线阅读
  ├─ 目录导航
  ├─ 关键词搜索
  └─ Agent 问答弹窗
        ↓
Agent 后端 API
  ├─ knowledge_search tool/API
  ├─ Agent /chat
  ├─ LLM 调用
  ├─ 限流与日志
  └─ 后续 MCP tool 封装
```

推荐核心原则：

```text
检索能力 = 独立 tool/API
RAG = Agent 调用检索 tool 后组织答案的流程
```

不要把检索逻辑写死在 `/chat` 里。`/chat` 应该是 `knowledge_search` 的消费者，而不是检索系统本身。

## 3. 前端功能设计

前端主要负责用户交互、内容展示和轻量搜索。

### 3.1 在线阅读

功能：

- 展示从 docx 转换出来的章节正文。
- 保留原始分级目录。
- 展示图片、图片说明和章节上下文。
- 支持章节锚点跳转。
- 支持移动端和桌面端阅读。

推荐页面结构：

```text
顶部栏
  ├─ 站点标题
  ├─ 搜索框
  └─ API/模型配置入口

主体区域
  ├─ 左侧目录树
  └─ 右侧正文阅读区

右下角
  └─ Agent 问答弹窗
```

### 3.2 目录导航

由文档解析阶段生成目录树：

```json
[
  {
    "title": "一级目录",
    "anchor": "/docs/main#section-1",
    "children": [
      {
        "title": "二级目录",
        "anchor": "/docs/main#section-1-1"
      }
    ]
  }
]
```

前端根据目录树渲染侧边栏。

### 3.3 前端关键词搜索

如果数据量不大，可以让前端加载 `search-index.json`，使用本地搜索库完成搜索。

可选方案：

- `MiniSearch`
- `FlexSearch`
- `Lunr.js`

前端搜索适合：

- 标题搜索。
- 正文关键词搜索。
- 搜索结果跳转。
- 无需调用服务器，节省成本。

注意：前端搜索主要服务用户阅读，不一定等同于 Agent 后端检索。Agent 后端应该有自己的 `knowledge_search` API，保证回答质量和可控性。

### 3.4 Agent 问答弹窗

弹窗功能：

- 输入用户问题。
- 显示 Agent 回答。
- 显示引用来源。
- 支持重新生成。
- 支持复制答案。
- 支持配置 LLM 接入方式。

用户配置项：

```json
{
  "provider": "custom",
  "apiBaseUrl": "https://example.com/v1",
  "apiKey": "用户自己的 key",
  "model": "model-name"
}
```

建议：

- 用户自己的 Key 存在浏览器 `localStorage`。
- 页面明确提示：Key 仅保存在用户浏览器本地。
- 如果请求必须经过你的后端代理，需要明确告知用户。

功能边界：

- 第一版 Agent 入口仅采用右下角悬浮按钮和问答弹窗。
- 不添加“询问当前章节”功能。
- 不添加“选中文字提问”功能。

## 4. 后端功能设计

后端主要负责知识库检索、Agent 问答、LLM 调用、安全控制和后续 MCP 化。

推荐拆成两个核心 API：

```text
POST /api/knowledge/search
POST /api/chat
```

其中：

- `/api/knowledge/search` 是稳定核心能力。
- `/api/chat` 是 Agent 问答能力，内部调用 `/api/knowledge/search`。

## 5. 知识库数据处理设计

### 5.1 文档解析

输入：

```text
英雄联盟武器更新计划.docx
```

输出：

```text
data/
  ├─ toc.json
  ├─ chunks.json
  ├─ search-index.json
  └─ images/
      ├─ image-001.png
      └─ image-002.png
```

解析目标：

- 提取标题层级。
- 提取正文段落。
- 提取图片。
- 保留图片与章节的关系。
- 为每个章节或切片生成稳定 `chunk_id` 和 `anchor`。

### 5.2 知识切片

建议按标题层级优先切片。

每个 chunk 建议控制在几百到一千多字以内。太短会缺上下文，太长会影响检索精度。

推荐数据结构：

```json
{
  "chunk_id": "doc-001-sec-003",
  "title": "当前小节标题",
  "title_path": ["一级目录", "二级目录", "三级目录"],
  "content": "正文内容",
  "images": [
    {
      "src": "/assets/images/image-001.png",
      "caption": "图片说明"
    }
  ],
  "source_doc": "英雄联盟武器更新计划.docx",
  "anchor": "/docs/main#doc-001-sec-003"
}
```

关键要求：

- 必须保留 `title_path`，方便引用和定位。
- 必须保留 `anchor`，方便前端跳转。
- 图片不要只作为静态资源存储，要和对应 chunk 建立关系。

## 6. knowledge_search Tool/API 设计

### 6.1 设计目标

`knowledge_search` 是整个项目的核心能力。它既服务：

- 前端高级搜索。
- Agent 问答。
- 后续 MCP tool。
- 未来其他外部 Agent 应用。

### 6.2 API 定义

接口：

```http
POST /api/knowledge/search
```

请求：

```json
{
  "query": "用户问题或关键词",
  "top_k": 5,
  "filters": {
    "chapter": "可选章节",
    "content_type": "text"
  },
  "mode": "keyword"
}
```

响应：

```json
{
  "query": "用户问题或关键词",
  "mode": "keyword",
  "results": [
    {
      "chunk_id": "doc-001-sec-003",
      "title": "章节标题",
      "title_path": ["一级目录", "二级目录"],
      "content": "命中的正文片段",
      "score": 12.7,
      "source": {
        "doc": "英雄联盟武器更新计划.docx",
        "anchor": "/docs/main#doc-001-sec-003"
      },
      "images": [],
      "highlights": ["命中的关键词片段"]
    }
  ]
}
```

### 6.3 第一阶段：关键词检索

推荐实现：

```text
SQLite + FTS5
```

原因：

- 单文件数据库，适合轻量服务器。
- 部署简单，不需要额外搜索服务。
- 支持后端统一检索。
- 后续可以继续加入 metadata、embedding、访问日志等表。

中文检索注意点：

- 如果 FTS5 默认分词效果不理想，可以采用字符 n-gram。
- 也可以在构建索引阶段预先分词。
- 第一版不必追求完美语义理解，先保证关键词命中、标题权重和来源引用稳定。

推荐排序策略：

```text
最终分数 =
  标题命中权重
  + 正文命中权重
  + 目录路径命中权重
  + 原始 BM25/FTS 分数
```

### 6.4 后续扩展：向量检索和重排

接口保持不变，只增加参数：

```json
{
  "query": "问题",
  "top_k": 8,
  "mode": "hybrid",
  "filters": {},
  "rerank": true
}
```

内部流程升级为：

```text
关键词召回
  +
向量召回
  ↓
结果合并去重
  ↓
分数融合
  ↓
rerank
  ↓
返回最终结果
```

这样不会破坏前端和 Agent 的调用方式。

## 7. Agent 问答设计

### 7.1 普通 RAG 第一版

第一版 `/api/chat` 可以采用普通 RAG：

```text
用户问题
  ↓
调用 knowledge_search 一次
  ↓
取 top_k 检索结果
  ↓
组装 prompt
  ↓
调用 LLM
  ↓
返回答案 + 来源引用
```

接口：

```http
POST /api/chat
```

请求：

```json
{
  "question": "用户问题",
  "history": [],
  "llm_config": {
    "provider": "server_default",
    "model": "default-model"
  }
}
```

响应：

```json
{
  "answer": "Agent 的回答",
  "citations": [
    {
      "chunk_id": "doc-001-sec-003",
      "title": "章节标题",
      "anchor": "/docs/main#doc-001-sec-003"
    }
  ],
  "search_results": [
    {
      "chunk_id": "doc-001-sec-003",
      "score": 12.7
    }
  ]
}
```

### 7.2 Agentic RAG 后续版本

后续可以升级为 Agentic RAG：

```text
用户问题
  ↓
Agent 判断需要查什么
  ↓
调用 knowledge_search
  ↓
阅读检索结果
  ↓
判断是否继续检索
  ↓
可能换关键词或加过滤条件再次检索
  ↓
整合多次检索结果
  ↓
最终回答
```

Agentic RAG 的关键不是“有一个 tool”，而是：

- Agent 可以决定是否检索。
- Agent 可以决定检索什么。
- Agent 可以多次检索。
- Agent 可以根据结果调整下一步。
- 最终基于证据回答。

建议第一版不要直接做复杂 Agentic RAG，先把 `knowledge_search` 设计好。只要这个 tool 稳定，后续升级很自然。

### 7.3 Agent 提示词与 tool 描述分层

建议采用双层策略：

```text
基础能力：knowledge_search tool 自解释
增强效果：官网 Agent 使用简短 system prompt
```

也就是说，`knowledge_search` 不应该依赖某个固定的 system prompt 才能发挥作用。它的 tool name、description、input schema 和返回格式本身就要写得足够清楚，让其他 Agent 或 MCP 客户端即使没有额外修改 system prompt，也能理解：

- 这个工具什么时候该用。
- 如何把复杂问题拆成多个 query。
- 什么时候需要多次调用。
- 检索结果不足时如何换关键词。
- 回答时应该基于 results，并尽量引用来源。

官网内置 Agent 可以额外使用一个简短 system prompt 来增强稳定性：

```text
你是一个知识库问答助手。回答用户问题时，优先基于知识库内容。

当问题涉及知识库资料、文档内容、规则、配置、更新计划、图片说明或具体条目时，必须使用 knowledge_search 工具检索相关资料。

回答要求：
- 基于检索结果回答，不要编造。
- 如果检索结果不足，说明资料中未找到明确依据。
- 回答要简洁、结构清楚。
- 尽量引用来源章节。
- 对复杂问题，可以多次调用 knowledge_search，分别检索关键概念、对象名称、对比项或限制条件。
```

但对外提供 MCP tool 时，不应要求用户必须复制这段 system prompt。更推荐的目标是：

```text
无 system prompt：可用，适合即插即用。
有推荐 system prompt：更稳，适合追求更高回答质量。
```

## 8. LLM 接入设计

支持两种模式。

### 8.1 站点默认 LLM

特点：

- 用户无需配置，开箱即用。
- API Key 存在后端，不能暴露给浏览器。
- 适合提供免费体验。

必须配套：

- 请求限流。
- IP 级别频率限制。
- 单次最大 token 限制。
- 日志记录。
- 错误回退。

### 8.2 用户自定义 LLM

特点：

- 用户输入自己的 API URL、API Key、模型名。
- 配置保存在浏览器本地。
- 可以支持 OpenAI-compatible API。

注意：

- 如果前端直接请求第三方 API，可能遇到 CORS 问题。
- 如果通过你的后端代理，要明确告知用户 Key 会发送到你的服务器。
- 更推荐提供两种选项：
  - 前端直连：隐私更好，但依赖目标 API 支持 CORS。
  - 后端代理：兼容性更好，但需要用户信任你的服务器。

## 9. MCP Tool 扩展设计

后续可以把 `knowledge_search` 封装成 MCP tool，供用户自己的 Agent 应用接入。

MCP tool 名称建议：

```text
knowledge_search
```

输入 schema：

```json
{
  "query": "string",
  "top_k": "number",
  "filters": {
    "chapter": "string",
    "content_type": "string"
  }
}
```

输出 schema：

```json
{
  "results": [
    {
      "chunk_id": "string",
      "title": "string",
      "title_path": ["string"],
      "content": "string",
      "source": {
        "doc": "string",
        "anchor": "string"
      },
      "score": "number"
    }
  ]
}
```

因为底层已经有 `/api/knowledge/search`，MCP tool 只需要作为一层适配器。

### 9.1 MCP Tool 描述封装

为了让 `knowledge_search` 后续作为 MCP tool 被其他 Agent 应用直接使用，tool 描述要尽量自解释。核心策略是：把“怎么检索、何时多次检索、如何改写查询、如何使用结果回答”尽量写进 tool description，而不是强依赖调用方修改 system prompt。

推荐 tool description：

```text
工具名称：knowledge_search

用途：
从当前知识库中检索与用户问题相关的文档片段，返回标题、目录路径、正文片段、图片引用、来源锚点和相关性分数。

适用场景：
- 用户询问文档中是否提到某个内容。
- 用户询问某个装备、角色、术语、规则、计划、配置或图片说明。
- 用户要求总结、对比、解释、查找依据。
- 用户问题包含多个对象时，可分别检索每个对象。
- 第一次检索结果不足时，可改写 query 后再次检索。

输入参数：
{
  "query": "要检索的问题、关键词或改写后的查询语句",
  "top_k": 5,
  "filters": {
    "chapter": "可选，限定章节或目录",
    "content_type": "可选，text/image/all"
  }
}

使用建议：
- query 应尽量包含用户问题中的核心名词。
- 对复杂问题，不要只检索完整问题，可以拆成多个 query。
- 对对比类问题，分别检索每个对比对象。
- 对原因、影响、限制类问题，可以追加“原因”“影响”“限制”“改动”等词重新检索。
- 如果检索结果分数低或内容不相关，应尝试换关键词再次检索。
- 最终回答应基于返回的 results，不要把未检索到的内容当成事实。

返回内容：
- chunk_id：知识片段 ID
- title：片段标题
- title_path：目录路径
- content：正文片段
- images：相关图片
- source.anchor：网页跳转锚点
- score：相关性分数
- highlights：命中的关键词
```

这种设计可以降低接入门槛。不同用户把 MCP tool 接入自己的 Agent 应用时，即使没有专门配置 system prompt，模型也能通过 tool 描述理解基本用法。

### 9.2 无 system prompt 与有 system prompt 的效果边界

只提供 `knowledge_search` tool，不额外提供 system prompt，也可以达到可用效果，尤其适合 MCP 即插即用场景。

但它的稳定性通常不如 “tool 自解释 + system prompt”：

- Agent 未必每次都会主动调用 tool。
- 不同模型对 tool description 的遵循程度不同。
- 引用来源和“不知道就说不知道”不一定稳定。
- 复杂问题是否多次检索，取决于 Agent 模型和框架。

因此推荐交付方式是：

```text
MCP tool 本身：做到无 system prompt 也能工作。
官网 Agent：额外配置简短 system prompt，保证检索调用率和引用稳定性。
文档说明：提供推荐 system prompt，供外部用户按需复制。
```

## 10. 推荐技术选型

### 10.1 前端

推荐：

```text
Vite + React
```

原因：

- 轻量。
- 部署到 GitHub Pages 简单。
- 适合自定义阅读界面和 Agent 弹窗。
- 后续接入复杂交互更灵活。

如果更偏文档站：

```text
VitePress 或 Docusaurus
```

但它们对自定义 Agent 弹窗、数据结构和复杂搜索的自由度稍弱。

### 10.2 后端

推荐二选一：

```text
Node.js + Fastify
Python + FastAPI
```

如果前端使用 TypeScript，后端也可以用 Node.js，类型和接口维护更统一。

如果后续要做文档解析、NLP、向量检索，Python 生态更方便。

### 10.3 数据存储

第一阶段：

```text
SQLite + FTS5
```

后续：

```text
SQLite metadata
+ 向量字段或独立向量库
```

可选向量库：

- SQLite 向量扩展。
- Chroma。
- Qdrant。

第一版不建议直接上复杂向量库，先用关键词检索把完整链路跑通。

## 11. 部署方案

### 11.1 前端部署

推荐：

```text
GitHub Pages
```

部署内容：

- 静态 HTML/CSS/JS。
- 图片资源。
- 目录树 JSON。
- 前端搜索索引。

### 11.2 后端部署

部署到轻量级服务器。

服务内容：

- `/api/knowledge/search`
- `/api/chat`
- `/api/health`
- SQLite 数据库文件。
- LLM API 配置。
- 限流和日志。

### 11.3 域名与跨域

如果前端在 GitHub Pages，后端在轻量服务器，需要配置 CORS。

建议：

```text
前端: https://yourname.github.io/your-repo
后端: https://api.your-domain.com
```

后端只允许你的前端域名跨域访问。

## 12. 安全与成本控制

必须考虑：

- 后端隐藏站点默认 API Key。
- 对 `/api/chat` 做频率限制。
- 对单个 IP 做每日额度。
- 限制问题长度。
- 限制单次检索 top_k。
- 限制 prompt 最大长度。
- 记录错误日志。
- 不在日志中保存用户 API Key。

建议默认策略：

```text
匿名用户:
  每分钟 3 次
  每天 50 次

单次检索:
  top_k <= 10

单次问题:
  最大 1000 字
```

## 13. 分阶段实施路线

### 第一阶段：静态知识库

目标：

- 解析 docx。
- 生成目录、正文、图片。
- 前端可以阅读。
- 前端可以关键词搜索。

产物：

```text
静态知识库网站
```

### 第二阶段：后端关键词检索

目标：

- 建立 SQLite FTS5 索引。
- 提供 `/api/knowledge/search`。
- 返回 chunk、score、source、highlight。

产物：

```text
可复用的 knowledge_search API
```

### 第三阶段：Agent 问答

目标：

- 提供 `/api/chat`。
- 后端调用 `knowledge_search`。
- 调用 LLM。
- 返回答案和引用来源。

产物：

```text
网页 Agent 问答弹窗可用
```

### 第四阶段：Agentic RAG

目标：

- Agent 可以多次调用 `knowledge_search`。
- 支持复杂问题拆解。
- 支持多次检索结果合并。

产物：

```text
更强的知识库 Agent
```

### 第五阶段：向量检索和重排

目标：

- 添加 embedding。
- 添加 hybrid search。
- 添加 rerank。
- 保持 `/api/knowledge/search` 对外接口基本稳定。

产物：

```text
更高质量的知识库检索
```

### 第六阶段：MCP Tool

目标：

- 把 `knowledge_search` 封装成 MCP tool。
- 允许外部 Agent 应用调用你的知识库。

产物：

```text
可被其他 Agent 接入的知识库工具
```

## 14. 最终推荐结论

推荐采用：

```text
静态前端知识库
+ 独立 knowledge_search API/tool
+ Agent 后端 /chat
+ 后续 MCP tool 适配
```

当前最优先做的是：

1. 把 docx 数据解析成结构化 chunks。
2. 设计稳定的 `knowledge_search` API。
3. 第一版用关键词检索，不急着上向量库。
4. `/chat` 作为检索 API 的消费者。
5. 后续在不改变前端和 Agent 调用方式的前提下，升级为向量检索、混合检索和 rerank。

这个设计能同时满足：

- 低成本上线。
- 免费 GitHub Pages 部署。
- 轻量服务器可承载。
- 后续可扩展 Agentic RAG。
- 后续可封装 MCP tool。
- 用户可自带 LLM API。
