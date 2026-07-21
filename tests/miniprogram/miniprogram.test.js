const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createArticleSubmission,
  createKnowledgeFromURL,
  createSession,
  generateSessionTitle,
  getCurrentUser,
  knowledgeChat,
  knowledgeChatStream,
  listKnowledgeBases,
  listMobileSubmissions,
  listSessions,
  previewMobileArticle,
  uploadMobileSubmissionFile,
  uploadKnowledgeFile
} = require("../../miniprogram/utils/request");
const { collectAnswerFromSSE, createSSEParser, parseSSE } = require("../../miniprogram/utils/sse");
const { normalizeMessages } = require("../../miniprogram/utils/normalize");
const { normalizeBaseUrl } = require("../../miniprogram/utils/config");
const {
  extractImportMaterials,
  getPendingImport,
  normalizeMaterial,
  savePendingImport
} = require("../../miniprogram/utils/import-material");
const { parseMarkdownToNodes } = require("../../miniprogram/utils/markdown");

test("parseSSE extracts event payloads", () => {
  const events = parseSSE('event: message\ndata: {"content":"hi"}\n\n');

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message");
  assert.equal(events[0].data, '{"content":"hi"}');
});

test("collectAnswerFromSSE joins answer chunks and skips references", () => {
  const raw = [
    'event: message\ndata: {"response_type":"references","content":"skip","done":false}',
    'event: message\ndata: {"response_type":"answer","content":"Hel","done":false}',
    'event: message\ndata: {"response_type":"answer","content":"lo","done":true}'
  ].join("\n\n");

  assert.equal(collectAnswerFromSSE(raw), "Hello");
});

test("createSSEParser handles partial chunks incrementally", () => {
  const events = [];
  const parser = createSSEParser((event) => events.push(event));

  parser.push('event: message\ndata: {"response_type":"answer","content":"Hel"');
  parser.push("}\n\n");
  parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"response_type":"answer","content":"Hel"}');
});

test("normalizeBaseUrl trims trailing slashes", () => {
  assert.equal(normalizeBaseUrl(" https://example.com/// "), "https://example.com");
});

test("markdown renderer maps common chat markdown to rich-text nodes", () => {
  const nodes = parseMarkdownToNodes([
    "### Title",
    "",
    "**Important** text with `code`",
    "",
    "- first",
    "- second",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |"
  ].join("\n"));

  assert.equal(nodes[0].name, "h3");
  assert.equal(nodes[1].name, "p");
  assert.equal(nodes[1].children[0].name, "strong");
  assert.equal(nodes[1].children.some((node) => node.name === "code"), true);
  assert.equal(nodes[2].name, "ul");
  assert.equal(nodes[3].name, "table");
});

test("markdown renderer normalizes inline latex math for mini program rich-text", () => {
  const nodes = parseMarkdownToNodes("Error $E$ domain: $\\{-n, \\dots, 0, \\dots, n\\}$, real error $e_{real}$, formula $K_e \\cdot e_{real}$.");
  const paragraph = nodes[0];
  const text = JSON.stringify(paragraph);

  assert.equal(paragraph.name, "p");
  assert.equal(text.includes("$"), false);
  assert.equal(text.includes("\\dots"), false);
  assert.equal(text.includes("{-n, ..., 0, ..., n}"), true);
  assert.equal(text.includes("\"name\":\"sub\""), true);
  assert.equal(text.includes("K"), true);
});
test("markdown renderer degrades unwrapped latex commands and fractions", () => {
  const nodes = parseMarkdownToNodes([
    "Rule match: \\alpha = \\min(\\mu_A(e_0), \\mu_B(eC_0)).",
    "Domain: \\( E \\in \\{-3, -2, -1, 0, 1, 2, 3\\} \\).",
    "$u = \\frac{\\sum_{k=1}^{m} v_k \\mu_U(v_k)}{\\sum_{k=1}^{m} \\mu_U(v_k)}$"
  ].join("\n"));
  const text = JSON.stringify(nodes);

  assert.equal(text.includes("\\alpha"), false);
  assert.equal(text.includes("\\min"), false);
  assert.equal(text.includes("\\mu"), false);
  assert.equal(text.includes("\\frac"), false);
  assert.equal(text.includes("alpha = min"), true);
  assert.equal(text.includes(" in "), true);
  assert.equal(text.includes("sum"), true);
  assert.equal(text.includes("\"name\":\"sub\""), true);
  assert.equal(text.includes("\"name\":\"sup\""), true);
});
test("markdown renderer supports likely latex variants without touching code", () => {
  const nodes = parseMarkdownToNodes([
    "Quadratic $\\sqrt{x^2} \\approx \\lambda_i \\to 0$ and $\\text{error}_{real}$.",
    "",
    "$",
    "\\begin{cases}",
    "u = PB, & e \\leq -2 \\\\",
    "u = NB, & e \\geq 2",
    "\\end{cases}",
    "$",
    "",
    "`\\alpha`",
    "",
    "```",
    "\\mu_A(e)",
    "```"
  ].join("\n"));
  const text = JSON.stringify(nodes);
  const inlineCode = nodes.find((node) => node.name === "p" && JSON.stringify(node).includes("\\alpha"));
  const codeBlock = nodes.find((node) => node.name === "pre");

  assert.equal(text.includes("\\sqrt"), false);
  assert.equal(text.includes("\\approx"), false);
  assert.equal(text.includes("\\lambda"), false);
  assert.equal(text.includes("\\begin"), false);
  assert.equal(text.includes("sqrt"), true);
  assert.equal(text.includes("~="), true);
  assert.equal(text.includes("->"), true);
  assert.equal(text.includes("begin cases"), true);
  assert.ok(inlineCode);
  assert.equal(JSON.stringify(inlineCode).includes("\\alpha"), true);
  assert.equal(JSON.stringify(codeBlock).includes("\\mu_A(e)"), true);
});
test("API helpers send WeKnora auth headers", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com/",
        selectedKnowledgeBaseId: "kb-1"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: { data: [] } });
    }
  };

  await listKnowledgeBases();

  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/knowledge-bases");
  assert.equal(capturedRequest.header["X-API-Key"], "sk-test");
  assert.match(capturedRequest.header["X-Request-ID"], /^mp-/);
});

test("URL import helper posts the selected URL payload", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com",
        selectedKnowledgeBaseId: "kb-1"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 201, data: { success: true } });
    }
  };

  await createKnowledgeFromURL("kb-1", "https://github.com/Tencent/WeKnora", true);

  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/knowledge-bases/kb-1/knowledge/url");
  assert.deepEqual(capturedRequest.data, {
    url: "https://github.com/Tencent/WeKnora",
    enable_multimodel: true,
    channel: "wechat"
  });
});

test("URL import helper includes optional title for shared articles", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com",
        selectedKnowledgeBaseId: "kb-1"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 201, data: { success: true } });
    }
  };

  await createKnowledgeFromURL("kb-1", "https://mp.weixin.qq.com/s/example", {
    title: "Article title",
    enableMultimodel: false
  });

  assert.deepEqual(capturedRequest.data, {
    url: "https://mp.weixin.qq.com/s/example",
    enable_multimodel: false,
    channel: "wechat",
    title: "Article title"
  });
});

test("chat helper includes selected knowledge base ids", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: "event: message\ndata: {}\n\n" });
    }
  };

  await knowledgeChat("session-1", "hello", "kb-1");

  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/knowledge-chat/session-1");
  assert.deepEqual(capturedRequest.data, {
    query: "hello",
    channel: "wechat",
    agent_enabled: false,
    knowledge_base_ids: ["kb-1"]
  });
});

test("create session helper omits default title for empty title", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 201, data: { data: { id: "session-1" } } });
    }
  };

  await createSession("");

  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/sessions");
  assert.deepEqual(capturedRequest.data, {});
});

test("generate session title helper posts first-round messages", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: { success: true, data: "Auto title" } });
    }
  };

  await generateSessionTitle("session-1", [
    { role: "user", content: "Introduce QStar" },
    { role: "assistant", content: "QStar is..." }
  ]);

  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/sessions/session-1/generate_title");
  assert.deepEqual(capturedRequest.data, {
    messages: [
      { role: "user", content: "Introduce QStar" },
      { role: "assistant", content: "QStar is..." }
    ]
  });
});

test("session list helper keeps source optional", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: { data: [] } });
    }
  };

  await listSessions({ page: 2, page_size: 10, keyword: "demo" });

  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/sessions?page=2&page_size=10&keyword=demo");
});

test("current user helper uses auth me endpoint with API key", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: { data: { user: { name: "Ada" } } } });
    }
  };

  await getCurrentUser();

  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/auth/me");
  assert.equal(capturedRequest.header["X-API-Key"], "sk-test");
});

test("upload helper sends multipart file with WeChat channel", async () => {
  let capturedUpload;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    uploadFile(options) {
      capturedUpload = options;
      options.success({ statusCode: 201, data: JSON.stringify({ success: true }) });
    }
  };

  await uploadKnowledgeFile("kb-1", { path: "/tmp/a.pdf", name: "a.pdf" });

  assert.equal(capturedUpload.url, "https://weknora.example.com/api/v1/knowledge-bases/kb-1/knowledge/file");
  assert.equal(capturedUpload.filePath, "/tmp/a.pdf");
  assert.equal(capturedUpload.name, "file");
  assert.deepEqual(capturedUpload.formData, {
    fileName: "a.pdf",
    channel: "wechat"
  });
  assert.equal(capturedUpload.header["X-API-Key"], "sk-test");
  assert.equal(capturedUpload.header["Content-Type"], undefined);
});

test("upload helper accepts WeChat shared file objects", async () => {
  let capturedUpload;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    uploadFile(options) {
      capturedUpload = options;
      options.success({ statusCode: 200, data: JSON.stringify({ success: true }) });
    }
  };

  await uploadKnowledgeFile("kb-1", { filePath: "wxfile://tmp/report.docx", fileName: "report.docx" });

  assert.equal(capturedUpload.filePath, "wxfile://tmp/report.docx");
  assert.deepEqual(capturedUpload.formData, {
    fileName: "report.docx",
    channel: "wechat"
  });
});

test("mobile article preview helper posts the selected article URL", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 200, data: { data: { title: "Article" } } });
    }
  };

  await previewMobileArticle("kb-1", "https://mp.weixin.qq.com/s/example");

  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/knowledge-bases/kb-1/mobile-submissions/article/preview");
  assert.deepEqual(capturedRequest.data, { url: "https://mp.weixin.qq.com/s/example" });
});

test("mobile article submission helper posts draft metadata", async () => {
  let capturedRequest;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      capturedRequest = options;
      options.success({ statusCode: 201, data: { success: true } });
    }
  };

  await createArticleSubmission("kb-1", {
    url: "https://mp.weixin.qq.com/s/example",
    title: "Article",
    materialType: "指南",
    note: "review",
    source: "微信公众号",
    publishedAt: "2026-07-15",
    summary: "summary",
    coverUrl: ""
  });

  assert.equal(capturedRequest.url, "https://weknora.example.com/api/v1/knowledge-bases/kb-1/mobile-submissions/article");
  assert.deepEqual(capturedRequest.data, {
    url: "https://mp.weixin.qq.com/s/example",
    title: "Article",
    material_type: "指南",
    note: "review",
    source: "微信公众号",
    published_at: "2026-07-15",
    summary: "summary",
    cover_url: ""
  });
});

test("mobile file draft upload sends multipart draft fields", async () => {
  let capturedUpload;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    uploadFile(options) {
      capturedUpload = options;
      options.success({ statusCode: 201, data: JSON.stringify({ success: true }) });
    }
  };

  await uploadMobileSubmissionFile("kb-1", { path: "/tmp/a.pdf", name: "a.pdf" }, {
    title: "A",
    materialType: "指南",
    note: "no phi"
  });

  assert.equal(capturedUpload.url, "https://weknora.example.com/api/v1/knowledge-bases/kb-1/mobile-submissions/file");
  assert.equal(capturedUpload.filePath, "/tmp/a.pdf");
  assert.deepEqual(capturedUpload.formData, {
    fileName: "a.pdf",
    title: "A",
    channel: "wechat",
    note: "no phi",
    material_type: "指南"
  });
});

test("upload helper rejects files without a readable WeChat path", async () => {
  await assert.rejects(
    uploadKnowledgeFile("kb-1", { name: "missing.pdf" }),
    /readable file path/
  );
});

test("import material parser distinguishes WeChat files and articles", () => {
  const materials = extractImportMaterials({
    scene: 1173,
    forwardMaterials: [
      { type: "file", name: "report.pdf", path: "wxfile://tmp/report.pdf", size: 2048 },
      { type: "webview", title: "Official Account", path: "https://mp.weixin.qq.com/s/example" }
    ]
  });

  assert.equal(materials.length, 2);
  assert.deepEqual(materials[0], {
    kind: "file",
    source: "wechat_file",
    name: "report.pdf",
    path: "wxfile://tmp/report.pdf",
    size: 2048,
    fileType: "pdf",
    raw: { type: "file", name: "report.pdf", path: "wxfile://tmp/report.pdf", size: 2048 }
  });
  assert.equal(materials[1].kind, "url");
  assert.equal(materials[1].url, "https://mp.weixin.qq.com/s/example");
  assert.equal(materials[1].title, "Official Account");
});

test("settings page returns to pending import after saving API settings", () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let storage = {};
  let redirectedTo = "";

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        return storage[key] || {};
      },
      setStorageSync(key, value) {
        storage[key] = value;
      },
      redirectTo(options) {
        redirectedTo = options.url;
      },
      showToast() {}
    };

    delete require.cache[require.resolve("../../miniprogram/pages/settings/settings.js")];
    require("../../miniprogram/pages/settings/settings.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data };
        Object.entries(nextData).forEach(([key, value]) => {
          if (!key.includes(".")) {
            this.data[key] = value;
            return;
          }
          const parts = key.split(".");
          let target = this.data;
          for (let i = 0; i < parts.length - 1; i += 1) {
            target[parts[i]] = target[parts[i]] || {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = value;
        });
      }
    };

    pageDefinitions[0].onLoad.call(page, {
      returnTo: encodeURIComponent("import-confirm"),
      importId: encodeURIComponent("imp-1")
    });
    page.setData({ baseUrl: "https://weknora.example.com", apiKey: "sk-test" });
    pageDefinitions[0].save.call(page);

    assert.equal(storage.weknora_settings.baseUrl, "https://weknora.example.com");
    assert.equal(storage.weknora_settings.apiKey, "sk-test");
    assert.equal(redirectedTo, "/pages/import-confirm/import-confirm?importId=imp-1");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("pending import storage round-trips normalized materials", () => {
  let stored;
  global.wx = {
    setStorageSync(key, value) {
      stored = { key, value };
    },
    getStorageSync(key) {
      return key === stored.key ? stored.value : undefined;
    }
  };

  const material = normalizeMaterial({ type: "file", name: "a.pdf", path: "wxfile://a.pdf" });
  const importId = savePendingImport(material);

  assert.match(importId, /^imp-/);
  assert.equal(getPendingImport(importId).materials[0].name, "a.pdf");
});

test("app launch stores WeChat shared materials for import confirmation", () => {
  const appDefinitions = [];
  const originalApp = global.App;
  const originalWx = global.wx;
  const storage = {};

  try {
    global.App = (definition) => {
      appDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        return storage[key];
      },
      setStorageSync(key, value) {
        storage[key] = value;
      },
    };

    delete require.cache[require.resolve("../../miniprogram/app.js")];
    require("../../miniprogram/app.js");
    appDefinitions[0].onLaunch({
      scene: 1173,
      forwardMaterials: [{ type: "file", name: "a.pdf", path: "wxfile://a.pdf" }]
    });

    assert.ok(storage.weknora_settings);
    assert.equal(storage.weknora_pending_import.materials[0].name, "a.pdf");
  } finally {
    global.App = originalApp;
    global.wx = originalWx;
  }
});

test("streaming chat emits answer chunks from wx chunk callbacks", async () => {
  const chunks = [];
  let chunkHandler;
  global.wx = {
    getStorageSync() {
      return {
        apiKey: "sk-test",
        baseUrl: "https://weknora.example.com"
      };
    },
    request(options) {
      setTimeout(() => {
        chunkHandler({
          data: Buffer.from('event: message\ndata: {"response_type":"answer","content":"Hi"}\n\n')
        });
        options.success({ statusCode: 200, data: "" });
      }, 0);
      return {
        onChunkReceived(handler) {
          chunkHandler = handler;
        }
      };
    }
  };

  const response = await knowledgeChatStream("session-1", "hello", "kb-1", (_chunk, answer) => {
    chunks.push(answer);
  });

  assert.deepEqual(chunks, ["Hi"]);
  assert.equal(response.answer, "Hi");
  assert.equal(response.streamed, true);
});

test("chat page shows raw assistant text and leaves title generation to backend", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  const requests = [];
  let storage = {
    apiKey: "sk-test",
    baseUrl: "https://weknora.example.com",
    selectedKnowledgeBaseId: "kb-1"
  };

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return storage;
      },
      setStorageSync(_key, value) {
        storage = value;
      },
      request(options) {
        requests.push({
          url: options.url,
          method: options.method,
          data: options.data
        });
        if (options.url.endsWith("/api/v1/sessions")) {
          options.success({ statusCode: 201, data: { data: { id: "session-1" } } });
          return {};
        }
        if (options.url.endsWith("/api/v1/knowledge-chat/session-1")) {
          options.success({
            statusCode: 200,
            data: 'event: message\ndata: {"response_type":"answer","content":"### Title\\n**Important**"}\n\n'
          });
          return {};
        }
        throw new Error(`Unexpected request: ${options.url}`);
      },
      showModal(options) {
        throw new Error(options.content || options.title);
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/chat/chat.js")];
    require("../../miniprogram/pages/chat/chat.js");
    const page = {
      data: {},
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };
    Object.assign(page, pageDefinitions[0]);
    page.data = { ...pageDefinitions[0].data, query: "Introduce QStar" };

    await page.ask();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(requests[0].url, "https://weknora.example.com/api/v1/sessions");
    assert.deepEqual(requests[0].data, {});
    assert.equal(requests.some((request) => request.url.includes("generate_title")), false);
    assert.equal(requests.some((request) => request.url.endsWith("/api/v1/sessions/session-1") && request.method === "PUT"), false);
    const assistantMessage = page.data.messages.find((message) => message.role === "assistant");
    assert.equal(assistantMessage.content, "### Title\n**Important**");
    assert.equal(assistantMessage.markdownNodes[0].name, "h3");
    assert.equal(assistantMessage.markdownNodes[1].children[0].name, "strong");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("chat page restores input and optimistic messages when streaming fails before an answer", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let storage = {
    apiKey: "sk-test",
    baseUrl: "https://weknora.example.com",
    selectedKnowledgeBaseId: "kb-1"
  };
  let modalContent = "";

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return storage;
      },
      setStorageSync(_key, value) {
        storage = value;
      },
      request(options) {
        if (options.url.endsWith("/api/v1/sessions")) {
          options.success({ statusCode: 201, data: { data: { id: "session-1" } } });
          return {};
        }
        if (options.url.endsWith("/api/v1/knowledge-chat/session-1")) {
          options.fail({ errMsg: "network down" });
          return {};
        }
        throw new Error(`Unexpected request: ${options.url}`);
      },
      showModal(options) {
        modalContent = options.content;
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/chat/chat.js")];
    require("../../miniprogram/pages/chat/chat.js");
    const originalMessages = [{ id: "old", role: "assistant", content: "ready", markdownNodes: [] }];
    const page = {
      data: {},
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };
    Object.assign(page, pageDefinitions[0]);
    page.data = { ...pageDefinitions[0].data, messages: originalMessages, query: "hello" };

    await page.ask();

    assert.equal(page.data.query, "hello");
    assert.deepEqual(page.data.messages, originalMessages);
    assert.equal(modalContent, "network down");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("chat page restores the knowledge base saved on a historical session", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  const requestedUrls = [];
  let storage = {
    apiKey: "sk-test",
    baseUrl: "https://weknora.example.com",
    selectedKnowledgeBaseId: "kb-current"
  };

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return storage;
      },
      setStorageSync(_key, value) {
        storage = value;
      },
      request(options) {
        requestedUrls.push(options.url);
        if (options.url.endsWith("/api/v1/sessions/session-1")) {
          options.success({
            statusCode: 200,
            data: { data: { id: "session-1", last_request_state: { knowledge_base_ids: ["kb-history"] } } }
          });
          return {};
        }
        if (options.url.endsWith("/api/v1/messages/session-1/load?limit=50")) {
          options.success({ statusCode: 200, data: { data: [] } });
          return {};
        }
        throw new Error(`Unexpected request: ${options.url}`);
      },
      showModal(options) {
        throw new Error(options.content || options.title);
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/chat/chat.js")];
    require("../../miniprogram/pages/chat/chat.js");
    const page = {
      data: {},
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };
    Object.assign(page, pageDefinitions[0]);
    page.data = { ...pageDefinitions[0].data };

    await page.switchSession("session-1");
    await Promise.resolve();

    assert.equal(storage.selectedKnowledgeBaseId, "kb-history");
    assert.deepEqual(requestedUrls, [
      "https://weknora.example.com/api/v1/sessions/session-1",
      "https://weknora.example.com/api/v1/messages/session-1/load?limit=50"
    ]);
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});
test("chat page does not regenerate title after history exists", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  const requests = [];

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com",
          selectedKnowledgeBaseId: "kb-1"
        };
      },
      request(options) {
        requests.push(options.url);
        options.success({
          statusCode: 200,
          data: 'event: message\ndata: {"response_type":"answer","content":"Next answer"}\n\n'
        });
        return {};
      },
      showModal(options) {
        throw new Error(options.content || options.title);
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/chat/chat.js")];
    require("../../miniprogram/pages/chat/chat.js");
    const page = {
      data: {},
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };
    Object.assign(page, pageDefinitions[0]);
    page.data = {
      ...pageDefinitions[0].data,
      sessionId: "session-1",
      query: "Next",
      messages: [{ id: "u-old", role: "user", content: "Old question" }]
    };

    await page.ask();

    assert.equal(requests.some((url) => url.includes("generate_title")), false);
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("normalizeMessages handles wrapped message lists", () => {
  const messages = normalizeMessages({
    data: [
      { id: "m1", role: "user", content: "Q" },
      { id: "m2", role: "assistant", content: "A" }
    ]
  });

  assert.deepEqual(messages.map((message) => `${message.role}:${message.content}`), ["user:Q", "assistant:A"]);
});

test("app shell uses collect page first and removes native tabBar", () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../miniprogram/app.json"), "utf8"));

  assert.equal(appConfig.pages[0], "pages/index/index");
  assert.equal(appConfig.pages.includes("pages/chat/chat"), true);
  assert.equal(appConfig.pages.includes("pages/clip-article/clip-article"), true);
  assert.equal(appConfig.pages.includes("pages/article-confirm/article-confirm"), true);
  assert.equal(appConfig.pages.includes("pages/upload-confirm/upload-confirm"), true);
  assert.equal(appConfig.pages.includes("pages/sessions/sessions"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(appConfig, "tabBar"), false);
  assert.equal(appConfig.window.navigationStyle, "custom");
  assert.equal(appConfig.usingComponents["bottom-nav"], "/components/bottom-nav/bottom-nav");
});

test("fixed bottom nav is present on collect, chat, and mine surfaces", () => {
  const indexWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/index/index.wxml"), "utf8");
  const chatWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/chat/chat.wxml"), "utf8");
  const settingsWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/settings/settings.wxml"), "utf8");
  const chatWxss = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/chat/chat.wxss"), "utf8");

  assert.equal(indexWxml.includes('<bottom-nav active="collect" />'), true);
  assert.equal(chatWxml.includes('<bottom-nav active="chat" />'), true);
  assert.equal(settingsWxml.includes('<bottom-nav active="mine" />'), true);
  assert.match(chatWxss, /bottom:\s*calc\(128rpx \+ env\(safe-area-inset-bottom\)\)/);
});

test("sidebar drawer loads, searches, and opens sessions", async () => {
  const componentDefinitions = [];
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let redirectedTo = "";
  let savedSettings;
  const requestedUrls = [];

  try {
    global.setTimeout = (fn) => {
      fn();
      return 1;
    };
    global.clearTimeout = () => {};
    global.Component = (definition) => {
      componentDefinitions.push(definition);
    };
    global.wx = {
      getSystemInfoSync() {
        return { statusBarHeight: 32 };
      },
      redirectTo(options) {
        redirectedTo = options.url;
      },
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com"
        };
      },
      request(options) {
        requestedUrls.push(options.url);
        if (options.url.endsWith("/api/v1/auth/me")) {
          options.success({
            statusCode: 200,
            data: {
              data: {
                user: {
                  name: "Desktop User",
                  avatar_url: "https://weknora.example.com/avatar.png"
                }
              }
            }
          });
          return;
        }
        options.success({
          statusCode: 200,
          data: {
            data: [
              { id: "session-1", title: "First chat", updated_at: "2026-07-15T10:00:00+08:00" },
              { id: "session-2", title: "Second chat", updated_at: "2026-07-15T11:00:00+08:00" }
            ],
            total: 2
          }
        });
      },
      setStorageSync(key, value) {
        savedSettings = { key, value };
      }
    };

    delete require.cache[require.resolve("../../miniprogram/components/sidebar-drawer/sidebar-drawer.js")];
    require("../../miniprogram/components/sidebar-drawer/sidebar-drawer.js");
    const component = {
      data: { ...componentDefinitions[0].data, activeKey: "chat" },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      },
      triggerEvent(name, detail) {
        this.triggered = { name, detail };
      }
    };
    Object.assign(component, componentDefinitions[0].methods);

    componentDefinitions[0].lifetimes.attached.call(component);
    component.openDrawer();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(component.data.open, true);
    assert.equal(component.data.drawerVisible, true);
    assert.equal(component.data.statusBarHeight, 32);
    assert.equal(component.data.accountName, "Desktop User");
    assert.equal(component.data.accountAvatar, "https://weknora.example.com/avatar.png");
    assert.equal(component.data.accountInitial, "D");
    assert.equal(component.data.sessions.length, 2);
    assert.equal(requestedUrls[0], "https://weknora.example.com/api/v1/auth/me");
    assert.equal(requestedUrls[1], "https://weknora.example.com/api/v1/sessions?page=1&page_size=30");

    component.onSearchInput({ detail: { value: "demo" } });
    await Promise.resolve();
    assert.equal(requestedUrls.at(-1), "https://weknora.example.com/api/v1/sessions?page=1&page_size=30&keyword=demo");

    component.openSession({ currentTarget: { dataset: { id: "session-2" } } });
    assert.equal(savedSettings.value.activeSessionId, "session-2");
    assert.deepEqual(component.triggered, { name: "opensession", detail: { sessionId: "session-2" } });

    component.closeDrawer();
    assert.equal(component.data.open, false);
    assert.equal(component.data.drawerVisible, false);

    component.goKnowledge();
    assert.equal(redirectedTo, "/pages/index/index");
    component.goSettings();
    assert.equal(redirectedTo, "/pages/settings/settings");
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test("sidebar drawer falls back when account profile is unavailable", async () => {
  const componentDefinitions = [];
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  try {
    global.setTimeout = (fn) => {
      fn();
      return 1;
    };
    global.clearTimeout = () => {};
    global.Component = (definition) => {
      componentDefinitions.push(definition);
    };
    global.wx = {
      getSystemInfoSync() {
        return {};
      },
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com"
        };
      },
      request(options) {
        if (options.url.endsWith("/api/v1/auth/me")) {
          options.fail({ errMsg: "network fail" });
          return;
        }
        options.success({ statusCode: 200, data: { data: [] } });
      }
    };

    delete require.cache[require.resolve("../../miniprogram/components/sidebar-drawer/sidebar-drawer.js")];
    require("../../miniprogram/components/sidebar-drawer/sidebar-drawer.js");
    const component = {
      data: { ...componentDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };
    Object.assign(component, componentDefinitions[0].methods);

    component.openDrawer();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(component.data.accountName, "WeKnora");
    assert.equal(component.data.accountAvatar, "");
    assert.equal(component.data.accountInitial, "W");
    assert.equal(component.data.accountLoaded, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test("collect page skips API loading until settings are configured", async () => {
  const calls = [];
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return {};
      },
      request() {
        calls.push("request");
      },
      redirectTo() {}
    };

    delete require.cache[require.resolve("../../miniprogram/pages/index/index.js")];
    require("../../miniprogram/pages/index/index.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    await pageDefinitions[0].onShow.call(page);

    assert.equal(page.data.needsSettings, true);
    assert.deepEqual(calls, []);
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("collect page maps API results to picker labels", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let savedSettings;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com"
        };
      },
      request(options) {
        options.success({
          statusCode: 200,
          data: {
            data: [
              { id: "kb-1", name: "Compliance KB" },
              { id: "kb-2", name: "Docs KB" }
            ]
          }
        });
      },
      setStorageSync(key, value) {
        savedSettings = { key, value };
      },
      redirectTo() {}
    };

    delete require.cache[require.resolve("../../miniprogram/pages/index/index.js")];
    require("../../miniprogram/pages/index/index.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    await pageDefinitions[0].loadKnowledgeBases.call(page);

    assert.deepEqual(page.data.knowledgeBaseNames, ["Compliance KB", "Docs KB"]);
    assert.equal(page.data.selectedKnowledgeBaseId, "kb-1");
    assert.equal(page.data.selectedKnowledgeBaseName, "Compliance KB");
    assert.equal(savedSettings.value.selectedKnowledgeBaseId, "kb-1");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("collect page maps recent submission status labels", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com"
        };
      },
      request(options) {
        assert.equal(options.url, "https://weknora.example.com/api/v1/mobile-submissions?page=1&page_size=5");
        options.success({
          statusCode: 200,
          data: {
            data: {
              data: [
                { id: "sub-1", kind: "article", title: "Article", status: "pending_review", created_at: "2026-07-21T09:42:00+08:00" },
                { id: "sub-2", kind: "file", title: "Guide", file_type: "pdf", status: "published", created_at: "2026-07-20T16:18:00+08:00" }
              ],
              total: 2
            }
          }
        });
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/index/index.js")];
    require("../../miniprogram/pages/index/index.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    await pageDefinitions[0].loadRecentSubmissions.call(page);

    assert.equal(page.data.recentSubmissions[0].statusText, "待审核");
    assert.equal(page.data.recentSubmissions[1].statusText, "已发布");
    assert.equal(page.data.recentSubmissions[1].fileBadge, "PDF");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("clip article page only reads clipboard after user action", () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let clipboardReads = 0;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return [];
      },
      getClipboardData(options) {
        clipboardReads += 1;
        options.success({ data: "https://mp.weixin.qq.com/s/example" });
        options.complete();
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/clip-article/clip-article.js")];
    require("../../miniprogram/pages/clip-article/clip-article.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    pageDefinitions[0].onShow.call(page);
    assert.equal(clipboardReads, 0);

    pageDefinitions[0].readClipboard.call(page);
    assert.equal(clipboardReads, 1);
    assert.equal(page.data.url, "https://mp.weixin.qq.com/s/example");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("knowledge detail refresh hides stale errors after files complete and keeps failed errors", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync() {
        return {
          apiKey: "sk-test",
          baseUrl: "https://weknora.example.com"
        };
      },
      setStorageSync() {},
      request(options) {
        if (options.url.endsWith("/api/v1/knowledge-bases/kb-1")) {
          options.success({ statusCode: 200, data: { data: { id: "kb-1", name: "Docs" } } });
          return;
        }
        if (options.url.includes("/api/v1/knowledge-bases/kb-1/knowledge")) {
          options.success({
            statusCode: 200,
            data: {
              data: [
                {
                  id: "file-completed",
                  file_name: "绗簩绔?鏂囨硶.pdf",
                  file_type: "pdf",
                  parse_status: "completed",
                  error_message: "Failed to load document (PDFium: Data format error)."
                },
                {
                  id: "file-failed",
                  file_name: "鍧忔枃浠?pdf",
                  file_type: "pdf",
                  parse_status: "failed",
                  error_message: "parse failed"
                }
              ],
              total: 2
            }
          });
          return;
        }
        throw new Error(`Unexpected request: ${options.url}`);
      },
      showModal(options) {
        throw new Error(options.content || options.title);
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/knowledge-detail/knowledge-detail.js")];
    require("../../miniprogram/pages/knowledge-detail/knowledge-detail.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data, id: "kb-1" },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    await pageDefinitions[0].loadAll.call(page, true);

    assert.equal(page.data.files[0].statusText, "completed");
    assert.equal(page.data.files[0].displayError, "");
    assert.equal(page.data.files[1].statusText, "failed");
    assert.equal(page.data.files[1].displayError, "parse failed");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("import confirm page imports selected shared article URL", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  const requests = [];
  let redirectedTo = "";
  let storage = {
    weknora_settings: {
      apiKey: "sk-test",
      baseUrl: "https://weknora.example.com",
      selectedKnowledgeBaseId: "kb-2"
    },
    weknora_pending_import: {
      id: "imp-1",
      materials: [
        {
          kind: "url",
          source: "wechat_article",
          title: "Article",
          url: "https://mp.weixin.qq.com/s/example"
        }
      ]
    }
  };

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        return storage[key];
      },
      setStorageSync(key, value) {
        storage[key] = value;
      },
      removeStorageSync(key) {
        delete storage[key];
      },
      request(options) {
        requests.push(options);
        if (options.url.endsWith("/api/v1/knowledge-bases")) {
          options.success({
            statusCode: 200,
            data: {
              data: [
                { id: "kb-1", name: "General", type: "document" },
                { id: "kb-2", name: "Research", type: "document" }
              ]
            }
          });
          return;
        }
        options.success({ statusCode: 201, data: { success: true } });
      },
      redirectTo(options) {
        redirectedTo = options.url;
      },
      showToast() {}
    };

    delete require.cache[require.resolve("../../miniprogram/pages/import-confirm/import-confirm.js")];
    require("../../miniprogram/pages/import-confirm/import-confirm.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    pageDefinitions[0].onLoad.call(page, { importId: "imp-1" });
    await pageDefinitions[0].onShow.call(page);
    await pageDefinitions[0].confirmImport.call(page);

    const importRequest = requests.find((item) => item.url.endsWith("/api/v1/knowledge-bases/kb-2/knowledge/url"));
    assert.ok(importRequest);
    assert.deepEqual(importRequest.data, {
      url: "https://mp.weixin.qq.com/s/example",
      enable_multimodel: false,
      channel: "wechat",
      title: "Article"
    });
    assert.equal(storage.weknora_pending_import, undefined);
    assert.equal(redirectedTo, "/pages/knowledge-detail/knowledge-detail?id=kb-2");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("import confirm page imports separate pasted URLs for multiple shared articles", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  const importRequests = [];
  let storage = {
    weknora_settings: {
      apiKey: "sk-test",
      baseUrl: "https://weknora.example.com",
      selectedKnowledgeBaseId: "kb-1"
    },
    weknora_pending_import: {
      id: "imp-urls",
      materials: [
        { kind: "url", source: "wechat_article", title: "Article A", url: "" },
        { kind: "url", source: "wechat_article", title: "Article B", url: "" }
      ]
    }
  };

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        return storage[key];
      },
      setStorageSync(key, value) {
        storage[key] = value;
      },
      removeStorageSync(key) {
        delete storage[key];
      },
      request(options) {
        if (options.url.endsWith("/api/v1/knowledge-bases")) {
          options.success({
            statusCode: 200,
            data: { data: [{ id: "kb-1", name: "Research", type: "document" }] }
          });
          return;
        }
        importRequests.push(options);
        options.success({ statusCode: 201, data: { success: true } });
      },
      redirectTo() {},
      showToast() {}
    };

    delete require.cache[require.resolve("../../miniprogram/pages/import-confirm/import-confirm.js")];
    require("../../miniprogram/pages/import-confirm/import-confirm.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data };
        Object.entries(nextData).forEach(([key, value]) => {
          if (!key.includes(".")) {
            this.data[key] = value;
            return;
          }
          const parts = key.split(".");
          let target = this.data;
          for (let i = 0; i < parts.length - 1; i += 1) {
            target[parts[i]] = target[parts[i]] || {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = value;
        });
      }
    };

    pageDefinitions[0].onLoad.call(page, { importId: "imp-urls" });
    await pageDefinitions[0].loadKnowledgeBases.call(page);
    pageDefinitions[0].onArticleUrlInput.call(page, {
      currentTarget: { dataset: { index: 0 } },
      detail: { value: "https://mp.weixin.qq.com/s/a" }
    });
    pageDefinitions[0].onArticleUrlInput.call(page, {
      currentTarget: { dataset: { index: 1 } },
      detail: { value: "https://mp.weixin.qq.com/s/b" }
    });
    await pageDefinitions[0].confirmImport.call(page);

    assert.equal(importRequests.length, 2);
    assert.equal(importRequests[0].data.url, "https://mp.weixin.qq.com/s/a");
    assert.equal(importRequests[0].data.title, "Article A");
    assert.equal(importRequests[1].data.url, "https://mp.weixin.qq.com/s/b");
    assert.equal(importRequests[1].data.title, "Article B");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("import confirm page guides settings before configured API", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let requests = 0;
  let redirectedTo = "";

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        if (key === "weknora_pending_import") {
          return {
            id: "imp-1",
            materials: [{ kind: "file", name: "a.pdf", path: "wxfile://a.pdf" }]
          };
        }
        return {};
      },
      request() {
        requests += 1;
      },
      redirectTo(options) {
        redirectedTo = options.url;
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/import-confirm/import-confirm.js")];
    require("../../miniprogram/pages/import-confirm/import-confirm.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    pageDefinitions[0].onLoad.call(page, { importId: "imp-1" });
    await pageDefinitions[0].onShow.call(page);
    pageDefinitions[0].openSettings.call(page);

    assert.equal(page.data.needsSettings, true);
    assert.equal(requests, 0);
    assert.equal(redirectedTo, "/pages/settings/settings?returnTo=import-confirm&importId=imp-1");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});

test("import confirm page reads latest pending import without import id", async () => {
  const pageDefinitions = [];
  const originalPage = global.Page;
  const originalWx = global.wx;

  try {
    global.Page = (definition) => {
      pageDefinitions.push(definition);
    };
    global.wx = {
      getStorageSync(key) {
        if (key === "weknora_settings") {
          return { apiKey: "", baseUrl: "" };
        }
        if (key === "weknora_pending_import") {
          return {
            id: "imp-auto",
            materials: [{ kind: "file", name: "shared.pdf", path: "wxfile://shared.pdf" }]
          };
        }
        return {};
      }
    };

    delete require.cache[require.resolve("../../miniprogram/pages/import-confirm/import-confirm.js")];
    require("../../miniprogram/pages/import-confirm/import-confirm.js");
    const page = {
      ...pageDefinitions[0],
      data: { ...pageDefinitions[0].data },
      setData(nextData) {
        this.data = { ...this.data, ...nextData };
      }
    };

    pageDefinitions[0].onLoad.call(page, {});

    assert.equal(page.data.importId, "imp-auto");
    assert.equal(page.data.materials[0].displayTitle, "shared.pdf");
  } finally {
    global.Page = originalPage;
    global.wx = originalWx;
  }
});
