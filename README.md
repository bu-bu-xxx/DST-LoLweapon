# 知识库 Agent MVP

基于 `英雄联盟武器更新计划.docx` 生成的轻量知识库网站与 Agent 后端。

## 功能

- 解析 docx，生成 `toc.json`、`chunks.json`、`search-index.json` 和图片资源。
- 静态网页支持目录阅读、图片展示和前端关键词搜索。
- 后端提供 `POST /api/knowledge/search` 和 `POST /api/chat`。
- `/api/chat` 会先调用知识库检索；未配置 LLM 时返回检索式摘要，配置 OpenAI-compatible API 后返回模型回答。
- 前端支持本地保存自定义 API Base URL、API Key 和模型名。

## 运行

```bash
npm.cmd run build:data
npm.cmd run dev
```

打开：

```text
http://localhost:3000
```

## API

```http
GET /api/health
POST /api/knowledge/search
POST /api/chat
```

搜索示例：

```json
{
  "query": "心之钢",
  "top_k": 3
}
```

问答示例：

```json
{
  "question": "心之钢有什么效果？"
}
```

## 默认 LLM 配置

服务端优先读取本地模型配置：

```text
server/models.local.json
```

这个文件包含真实 API Key，已被 `.gitignore` 排除，不应提交到仓库。可以参考：

```text
server/models.example.json
```

当前后端还提供：

```http
GET /api/models
POST /api/models/test
```

`GET /api/models` 只返回模型 ID、展示名称和功能标签，不返回 API Key。

如果没有 `server/models.local.json`，也可以通过环境变量提供一个默认模型：

```text
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
```

网页右上角可以选择后端免费模型，也可以配置用户自己的 OpenAI-compatible API。自定义配置保存在浏览器 `localStorage`。

## Tavily 联网搜索

网页配置窗口支持用户输入自己的 Tavily API Key，并开启或关闭“联网搜索”。

开启后：

- 前端把 Tavily Key 随本次 `/api/chat` 请求发送给本地后端。
- 后端调用 `https://api.tavily.com/search`。
- Tavily 返回的网页结果会作为 `[W1]`、`[W2]` 等联网来源加入 Agent prompt。
- 响应会返回 `web_results`，前端会展示可点击的联网来源链接。

Tavily Key 只保存在浏览器 `localStorage`，不会写入项目文件。

## 前后端分离部署

前端可以部署到 GitHub Pages，后端部署到自己的服务器。

如果后端地址是：

```text
https://backend.example.com
```

并且该域名转发到后端 Node 服务的 `3000` 端口，则在网页右上角 `LLM 配置` 中填写：

```text
https://backend.example.com
```

前端会自动调用：

```text
https://backend.example.com/api/models
https://backend.example.com/api/chat
```

本地开发时可以留空，留空表示使用当前页面同源后端，例如 `http://localhost:3000/api/chat`。
