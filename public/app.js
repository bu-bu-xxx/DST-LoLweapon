const state = {
  chunks: [],
  customModels: JSON.parse(localStorage.getItem("customModels") || "[]"),
  index: [],
  models: [],
  searchDocs: [],
  toc: [],
  config: JSON.parse(localStorage.getItem("llmConfig") || '{"provider":"server_model"}'),
};

let searchTimer = 0;
let backendTimer = 0;
let isComposingSearch = false;

const els = {
  toc: document.querySelector("#toc"),
  content: document.querySelector("#content"),
  siteSearch: document.querySelector("#siteSearch"),
  searchSubmit: document.querySelector("#searchSubmit"),
  searchResults: document.querySelector("#searchResults"),
  chatFab: document.querySelector("#chatFab"),
  chatPanel: document.querySelector("#chatPanel"),
  closeChat: document.querySelector("#closeChat"),
  chatMessages: document.querySelector("#chatMessages"),
  chatForm: document.querySelector("#chatForm"),
  questionInput: document.querySelector("#questionInput"),
  configBtn: document.querySelector("#configBtn"),
  configDialog: document.querySelector("#configDialog"),
  chatServerModel: document.querySelector("#chatServerModel"),
  chatEnableTavilySearch: document.querySelector("#chatEnableTavilySearch"),
  tavilyApiKey: document.querySelector("#tavilyApiKey"),
  backendBaseUrl: document.querySelector("#backendBaseUrl"),
  customModelList: document.querySelector("#customModelList"),
  customModelLabel: document.querySelector("#customModelLabel"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  apiKey: document.querySelector("#apiKey"),
  modelName: document.querySelector("#modelName"),
  saveConfig: document.querySelector("#saveConfig"),
  clearConfig: document.querySelector("#clearConfig"),
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function modelOptionValue(type, id) {
  return `${type}:${id}`;
}

function parseModelOption(value) {
  const [type, ...rest] = String(value || "").split(":");
  return { type, id: rest.join(":") };
}

function normalizeBackendBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function apiUrl(path) {
  const base = normalizeBackendBaseUrl(state.config.backendBaseUrl);
  return `${base}${path}`;
}

function renderToc(items) {
  const renderItems = (nodes) => `
    <ul class="toc-list">
      ${nodes
        .map(
          (item) => `
            <li>
              <a href="${item.anchor}">${escapeHtml(item.title)}</a>
              ${item.children?.length ? renderItems(item.children) : ""}
            </li>
          `,
        )
        .join("")}
    </ul>`;
  els.toc.innerHTML = renderItems(items);
}

function renderContent(chunks) {
  els.content.innerHTML = chunks
    .map((chunk) => {
      const level = Math.max(2, Math.min((chunk.title_path?.length || 1) + 1, 6));
      const paragraphs = (chunk.paragraphs || [])
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("");
      const images = (chunk.images || [])
        .map(
          (image) => `
            <figure>
              <img src="${image.src}" alt="${escapeHtml(image.caption || chunk.title)}" loading="lazy">
              <figcaption>${escapeHtml(image.caption || chunk.title)}</figcaption>
            </figure>
          `,
        )
        .join("");
      return `
        <section id="${chunk.chunk_id}" class="doc-section">
          <h${level}>${escapeHtml(chunk.title)}</h${level}>
          <div class="section-path">${escapeHtml((chunk.title_path || []).join(" / "))}</div>
          ${paragraphs}
          ${images}
        </section>
      `;
    })
    .join("");
}

function termsOf(query) {
  const normalized = query.toLowerCase();
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
  const words = normalized
    .split(/[\s,，.。;；:：!?！？、"'“”‘’()[\]{}<>《》/\\|-]+/)
    .filter((term) => term.length >= 2);
  return [...new Set([...words, ...cjk])];
}

function countOccurrences(text, term, max = 20) {
  if (!text || !term) return 0;
  let count = 0;
  let position = 0;
  while (count < max) {
    const found = text.indexOf(term, position);
    if (found === -1) break;
    count += 1;
    position = found + term.length;
  }
  return count;
}

function prepareSearchDocs(index) {
  return index.map((item) => {
    const titleText = `${item.title} ${(item.title_path || []).join(" ")}`.toLowerCase();
    const bodyText = String(item.content || "").toLowerCase();
    const previewText = String(item.content || "").replace(/\s+/g, " ").slice(0, 150);
    return {
      item,
      titleText,
      bodyText,
      previewText,
    };
  });
}

function localSearch(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const terms = termsOf(trimmed).slice(0, 8);
  if (!terms.length) return [];

  return state.searchDocs
    .map((doc) => {
      const score = terms.reduce((sum, term) => {
        const titleHits = countOccurrences(doc.titleText, term, 8);
        const bodyHits = countOccurrences(doc.bodyText, term, 20);
        return sum + titleHits * 8 + bodyHits;
      }, 0);
      return { item: doc.item, previewText: doc.previewText, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function renderSearch(query) {
  const results = localSearch(query);
  if (!query.trim()) {
    els.searchResults.hidden = true;
    els.searchResults.innerHTML = "";
    return;
  }
  els.searchResults.hidden = false;
  els.searchResults.innerHTML = `
    <header>找到 ${results.length} 条相关内容</header>
    ${
      results.length
        ? results
            .map(({ item, previewText }) => {
              return `
                <a class="result-item" href="${item.anchor}">
                  <strong>${escapeHtml(item.title)}</strong>
                  <span>${escapeHtml(previewText)}</span>
                </a>
              `;
            })
            .join("")
        : '<div class="result-item"><span>没有匹配结果</span></div>'
    }
  `;
}

function addMessage(role, text, citations = [], webResults = []) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  if (citations.length || webResults.length) {
    const citeBox = document.createElement("div");
    citeBox.className = "citations";
    citeBox.innerHTML = [
      ...citations.map((citation) => `<a href="${citation.anchor}">知识库：${escapeHtml(citation.title)}</a>`),
      ...webResults.map(
        (item) =>
          `<a href="${item.url}" target="_blank" rel="noopener noreferrer">联网：${escapeHtml(item.title || item.url)}</a>`,
      ),
    ].join("");
    node.append(citeBox);
  }
  els.chatMessages.append(node);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderModelSelect() {
  const serverOptions = state.models
    .map((model) => `<option value="${modelOptionValue("server", model.id)}">${escapeHtml(model.label)}</option>`)
    .join("");
  const customOptions = state.customModels
    .map((model) => `<option value="${modelOptionValue("custom", model.id)}">${escapeHtml(model.label)}</option>`)
    .join("");
  els.chatServerModel.innerHTML = `
    ${serverOptions ? `<optgroup label="免费模型">${serverOptions}</optgroup>` : ""}
    ${customOptions ? `<optgroup label="自定义模型">${customOptions}</optgroup>` : ""}
    ${!serverOptions && !customOptions ? '<option value="">暂无可用模型</option>' : ""}
  `;

  const selectedValue =
    state.config.provider === "custom"
      ? modelOptionValue("custom", state.config.custom_model_id)
      : modelOptionValue("server", state.config.model_id || state.models[0]?.id || "");
  if ([...els.chatServerModel.options].some((option) => option.value === selectedValue)) {
    els.chatServerModel.value = selectedValue;
  }
}

function renderCustomModelList() {
  els.customModelList.innerHTML = state.customModels.length
    ? state.customModels
        .map(
          (model) => `
            <div class="custom-model-item">
              <div>
                <strong>${escapeHtml(model.label)}</strong>
                <span>${escapeHtml(model.model)} · ${escapeHtml(model.apiBaseUrl)}</span>
              </div>
              <button type="button" data-delete-custom-model="${model.id}">删除</button>
            </div>
          `,
        )
        .join("")
    : '<div class="custom-model-item"><div><strong>还没有自定义模型</strong><span>添加后会出现在 Agent 窗口的模型下拉里</span></div></div>';
}

function fillConfigForm() {
  renderModelSelect();
  renderCustomModelList();
  els.backendBaseUrl.value = state.config.backendBaseUrl || "";
  els.chatEnableTavilySearch.checked = Boolean(state.config.web_search?.enabled);
  els.tavilyApiKey.value = state.config.web_search?.tavilyApiKey || "";
}

function saveConfig() {
  localStorage.setItem("llmConfig", JSON.stringify(state.config));
}

function saveCustomModels() {
  localStorage.setItem("customModels", JSON.stringify(state.customModels));
}

function saveChatOptions({ switchToServerModel = false } = {}) {
  const selected = parseModelOption(els.chatServerModel.value);
  if (selected.type === "custom") {
    state.config.provider = "custom";
    state.config.custom_model_id = selected.id;
  } else {
    state.config.provider = "server_model";
    state.config.model_id = selected.id || state.models[0]?.id || "";
    delete state.config.custom_model_id;
  }
  state.config.web_search = {
    enabled: els.chatEnableTavilySearch.checked,
    tavilyApiKey: state.config.web_search?.tavilyApiKey || "",
  };
  if (switchToServerModel) {
    delete state.config.apiBaseUrl;
    delete state.config.apiKey;
    delete state.config.model;
  }
  saveConfig();
}

async function sendQuestion(question) {
  const customModel = state.customModels.find((model) => model.id === state.config.custom_model_id);
  const llm_config =
    state.config.provider === "custom" && customModel
      ? {
          provider: "custom",
          apiBaseUrl: customModel.apiBaseUrl,
          apiKey: customModel.apiKey,
          model: customModel.model,
        }
      : { provider: "server_model", model_id: state.config.model_id || state.models[0]?.id };

  const web_search =
    state.config.web_search?.enabled && state.config.web_search?.tavilyApiKey
      ? {
          provider: "tavily",
          enabled: true,
          apiKey: state.config.web_search.tavilyApiKey,
        }
      : { enabled: false };

  const response = await fetch(apiUrl("/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, llm_config, web_search }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadBackendModels() {
  const modelsResponse = await fetch(apiUrl("/api/models"))
    .then((res) => {
      if (!res.ok) throw new Error(`models request failed: ${res.status}`);
      return res.json();
    })
    .catch(() => ({ models: [] }));
  state.models = modelsResponse.models || [];
  const hasSelectedServerModel = state.models.some((model) => model.id === state.config.model_id);
  if (state.config.provider !== "custom" && (!state.config.model_id || !hasSelectedServerModel) && state.models[0]?.id) {
    state.config.model_id = state.models[0].id;
    state.config.provider = "server_model";
    saveConfig();
  }
  renderModelSelect();
}

async function init() {
  const [toc, chunks, index] = await Promise.all([
    fetch("/data/toc.json").then((res) => res.json()),
    fetch("/data/chunks.json").then((res) => res.json()),
    fetch("/data/search-index.json").then((res) => res.json()),
  ]);
  state.toc = toc;
  state.chunks = chunks;
  state.index = index;
  state.searchDocs = prepareSearchDocs(index);
  renderToc(toc);
  renderContent(chunks);
  await loadBackendModels();
  fillConfigForm();
}

function scheduleSearch(value) {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => renderSearch(value), 180);
}

function showSearchResults(value) {
  window.clearTimeout(searchTimer);
  renderSearch(value);
  if (!value.trim()) return;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    els.searchResults.focus?.({ preventScroll: true });
  });
}

els.siteSearch.addEventListener("compositionstart", () => {
  isComposingSearch = true;
});
els.siteSearch.addEventListener("compositionend", (event) => {
  isComposingSearch = false;
  scheduleSearch(event.target.value);
});
els.siteSearch.addEventListener("input", (event) => {
  if (isComposingSearch) return;
  scheduleSearch(event.target.value);
});
els.siteSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || isComposingSearch) return;
  event.preventDefault();
  showSearchResults(event.currentTarget.value);
});
els.searchSubmit.addEventListener("click", () => {
  showSearchResults(els.siteSearch.value);
});
els.chatServerModel.addEventListener("change", () => {
  const selected = parseModelOption(els.chatServerModel.value);
  saveChatOptions({ switchToServerModel: selected.type === "server" });
  fillConfigForm();
});
els.chatEnableTavilySearch.addEventListener("change", () => {
  saveChatOptions();
});
els.tavilyApiKey.addEventListener("input", () => {
  state.config.web_search = {
    enabled: els.chatEnableTavilySearch.checked,
    tavilyApiKey: els.tavilyApiKey.value.trim(),
  };
  saveConfig();
});
els.backendBaseUrl.addEventListener("change", async () => {
  state.config.backendBaseUrl = normalizeBackendBaseUrl(els.backendBaseUrl.value);
  saveConfig();
  await loadBackendModels();
  fillConfigForm();
});
els.backendBaseUrl.addEventListener("input", () => {
  window.clearTimeout(backendTimer);
  backendTimer = window.setTimeout(async () => {
    state.config.backendBaseUrl = normalizeBackendBaseUrl(els.backendBaseUrl.value);
    saveConfig();
    await loadBackendModels();
    fillConfigForm();
  }, 700);
});
els.chatFab.addEventListener("click", () => {
  els.chatPanel.hidden = false;
  fillConfigForm();
  els.questionInput.focus();
});
els.closeChat.addEventListener("click", () => {
  els.chatPanel.hidden = true;
});
els.configBtn.addEventListener("click", () => {
  fillConfigForm();
  els.configDialog.showModal();
});
els.saveConfig.addEventListener("click", () => {
  const apiBaseUrl = els.apiBaseUrl.value.trim();
  const apiKey = els.apiKey.value.trim();
  const model = els.modelName.value.trim();
  state.config.web_search = {
    enabled: els.chatEnableTavilySearch.checked,
    tavilyApiKey: els.tavilyApiKey.value.trim(),
  };
  state.config.backendBaseUrl = normalizeBackendBaseUrl(els.backendBaseUrl.value);
  if (!apiBaseUrl || !apiKey || !model) {
    saveConfig();
    loadBackendModels().finally(() => fillConfigForm());
    return;
  }

  const customModel = {
    id: `custom-${Date.now()}`,
    label: els.customModelLabel.value.trim() || model,
    apiBaseUrl,
    apiKey,
    model,
  };
  state.customModels.push(customModel);
  saveCustomModels();
  state.config.provider = "custom";
  state.config.custom_model_id = customModel.id;
  saveConfig();
  els.customModelLabel.value = "";
  els.apiBaseUrl.value = "";
  els.apiKey.value = "";
  els.modelName.value = "";
  fillConfigForm();
});
els.clearConfig.addEventListener("click", () => {
  state.config = { provider: "server_model", model_id: state.models[0]?.id, web_search: state.config.web_search };
  localStorage.removeItem("llmConfig");
  saveConfig();
  fillConfigForm();
});
els.customModelList.addEventListener("click", (event) => {
  const id = event.target?.dataset?.deleteCustomModel;
  if (!id) return;
  state.customModels = state.customModels.filter((model) => model.id !== id);
  if (state.config.custom_model_id === id) {
    state.config = { provider: "server_model", model_id: state.models[0]?.id, web_search: state.config.web_search };
    saveConfig();
  }
  saveCustomModels();
  fillConfigForm();
});
els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = els.questionInput.value.trim();
  if (!question) return;
  els.questionInput.value = "";
  addMessage("user", question);
  addMessage("agent", "正在检索知识库...");
  const pending = els.chatMessages.lastElementChild;
  try {
    const data = await sendQuestion(question);
    pending.remove();
    addMessage("agent", data.answer, data.citations || [], data.web_results || []);
  } catch (error) {
    pending.remove();
    addMessage("agent", `请求失败：${error.message}`);
  }
});

init().catch((error) => {
  els.content.innerHTML = `<section class="doc-section"><h2>加载失败</h2><p>${escapeHtml(error.message)}</p></section>`;
});
