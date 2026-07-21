const { getSettings } = require("./config");
const { collectAnswerFromSSE, createSSEParser, extractAnswerChunk } = require("./sse");

function buildQuery(params = {}) {
  const pairs = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

function getConfiguredSettings() {
  const settings = getSettings();
  if (!settings.baseUrl) {
    throw new Error("Please configure the WeKnora API Base URL first.");
  }
  if (!settings.apiKey) {
    throw new Error("Please configure the WeKnora API Key first.");
  }
  return settings;
}

function createHeaders(settings, contentType = "application/json") {
  const header = {
    "X-API-Key": settings.apiKey,
    "X-Request-ID": `mp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
  if (contentType) {
    header["Content-Type"] = contentType;
  }
  return header;
}

function responseError(response) {
  return new Error(response.data?.error?.message || response.data?.message || `HTTP ${response.statusCode}`);
}

function request(path, options = {}) {
  let settings;
  try {
    settings = getConfiguredSettings();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${settings.baseUrl}${path}`,
      method: options.method || "GET",
      data: options.data,
      header: createHeaders(settings),
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(responseError(response));
      },
      fail(error) {
        reject(new Error(error.errMsg || "Network request failed."));
      }
    });
  });
}

function arrayBufferToString(buffer) {
  if (typeof buffer === "string") {
    return buffer;
  }
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(buffer);
  }
  const bytes = new Uint8Array(buffer || []);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  try {
    return decodeURIComponent(escape(binary));
  } catch (error) {
    return binary;
  }
}

function streamRequest(path, options = {}) {
  let settings;
  try {
    settings = getConfiguredSettings();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let emittedChunks = false;
    let collectedAnswer = "";
    const parser = createSSEParser((event) => {
      const chunk = extractAnswerChunk(event);
      if (!chunk) return;
      emittedChunks = true;
      collectedAnswer += chunk;
      if (options.onChunk) {
        options.onChunk(chunk, collectedAnswer);
      }
    });

    const task = wx.request({
      url: `${settings.baseUrl}${path}`,
      method: options.method || "POST",
      data: options.data,
      enableChunked: true,
      responseType: "text",
      header: createHeaders(settings),
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(responseError(response));
          return;
        }

        parser.flush();
        const rawResponse = typeof response.data === "string" ? response.data : JSON.stringify(response.data || "");
        if (!emittedChunks && rawResponse) {
          const answer = collectAnswerFromSSE(rawResponse);
          if (answer && options.onChunk) {
            emittedChunks = true;
            collectedAnswer = answer;
            options.onChunk(answer, answer);
          }
        }
        resolve({
          data: response.data,
          answer: collectedAnswer,
          streamed: emittedChunks
        });
      },
      fail(error) {
        reject(new Error(error.errMsg || "Network request failed."));
      }
    });

    if (task && typeof task.onChunkReceived === "function") {
      task.onChunkReceived((event) => {
        parser.push(arrayBufferToString(event.data));
      });
    }
  });
}

function upload(path, filePath, formData = {}) {
  let settings;
  try {
    settings = getConfiguredSettings();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${settings.baseUrl}${path}`,
      filePath,
      name: "file",
      formData,
      header: createHeaders(settings, null),
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let data = response.data;
          try {
            data = JSON.parse(response.data);
          } catch (error) {
            data = { message: response.data };
          }
          reject(responseError({ statusCode: response.statusCode, data }));
          return;
        }
        try {
          resolve(typeof response.data === "string" ? JSON.parse(response.data) : response.data);
        } catch (error) {
          reject(new Error("Upload response is not valid JSON."));
        }
      },
      fail(error) {
        reject(new Error(error.errMsg || "File upload failed."));
      }
    });
  });
}

function listKnowledgeBases(params = {}) {
  return request(`/api/v1/knowledge-bases${buildQuery(params)}`);
}

function getCurrentUser() {
  return request("/api/v1/auth/me");
}

function getKnowledgeBase(knowledgeBaseId) {
  return request(`/api/v1/knowledge-bases/${knowledgeBaseId}`);
}

function listKnowledgeFiles(knowledgeBaseId, params = {}) {
  return request(`/api/v1/knowledge-bases/${knowledgeBaseId}/knowledge${buildQuery({
    page: params.page || 1,
    page_size: params.page_size || 20,
    keyword: params.keyword,
    file_type: params.file_type,
    parse_status: params.parse_status,
    source: params.source,
    tag_ids: params.tag_ids
  })}`);
}

function withOriginalExtension(title, file) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return "";
  if (/\.[a-z0-9]+$/i.test(cleanTitle)) return cleanTitle;
  const sourceName = String(file.name || file.fileName || file.title || "");
  const match = sourceName.match(/(\.[a-z0-9]+)$/i);
  return match ? `${cleanTitle}${match[1]}` : cleanTitle;
}

function uploadKnowledgeFile(knowledgeBaseId, file, options = {}) {
  const filePath = file.path || file.tempFilePath || file.filePath;
  if (!filePath) {
    return Promise.reject(new Error("WeChat did not provide a readable file path for this file."));
  }
  const metadata = {};
  if (options.materialType) metadata.material_type = options.materialType;
  if (options.note) metadata.note = options.note;

  const formData = {
    fileName: withOriginalExtension(options.title, file) || file.name || file.fileName || file.title || "upload",
    channel: "wechat"
  };
  if (Object.keys(metadata).length) {
    formData.metadata = JSON.stringify(metadata);
  }
  return upload(`/api/v1/knowledge-bases/${knowledgeBaseId}/knowledge/file`, filePath, {
    ...formData
  });
}

function createKnowledgeFromURL(knowledgeBaseId, url, options = false) {
  const payload = {
    url,
    enable_multimodel: false,
    channel: "wechat"
  };
  if (typeof options === "boolean") {
    payload.enable_multimodel = options;
  } else if (options && typeof options === "object") {
    payload.enable_multimodel = options.enableMultimodel === true;
    if (options.title) payload.title = options.title;
    if (options.fileName) payload.file_name = options.fileName;
    if (options.fileType) payload.file_type = options.fileType;
  }
  return request(`/api/v1/knowledge-bases/${knowledgeBaseId}/knowledge/url`, {
    method: "POST",
    data: payload
  });
}

function createSession(title = "") {
  return request("/api/v1/sessions", {
    method: "POST",
    data: title ? { title } : {}
  });
}

function knowledgeChat(sessionId, query, knowledgeBaseId) {
  const data = { query, channel: "wechat", agent_enabled: false };
  if (knowledgeBaseId) {
    data.knowledge_base_ids = [knowledgeBaseId];
  }

  return request(`/api/v1/knowledge-chat/${sessionId}`, {
    method: "POST",
    data
  });
}

function knowledgeChatStream(sessionId, query, knowledgeBaseId, onChunk) {
  const data = { query, channel: "wechat", agent_enabled: false };
  if (knowledgeBaseId) {
    data.knowledge_base_ids = [knowledgeBaseId];
  }
  return streamRequest(`/api/v1/knowledge-chat/${sessionId}`, {
    method: "POST",
    data,
    onChunk
  });
}

function listSessions(params = {}) {
  return request(`/api/v1/sessions${buildQuery({
    page: params.page || 1,
    page_size: params.page_size || 20,
    keyword: params.keyword,
    source: params.source
  })}`);
}

function getSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}`);
}

function updateSession(sessionId, data) {
  return request(`/api/v1/sessions/${sessionId}`, {
    method: "PUT",
    data
  });
}

function deleteSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}`, {
    method: "DELETE"
  });
}

function pinSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/pin`, {
    method: "POST",
    data: {}
  });
}

function unpinSession(sessionId) {
  return request(`/api/v1/sessions/${sessionId}/pin`, {
    method: "DELETE"
  });
}

function generateSessionTitle(sessionId, messages) {
  return request(`/api/v1/sessions/${sessionId}/generate_title`, {
    method: "POST",
    data: { messages }
  });
}

function loadMessages(sessionId, limit = 30, beforeTime = "") {
  return request(`/api/v1/messages/${sessionId}/load${buildQuery({
    limit,
    before_time: beforeTime
  })}`);
}

module.exports = {
  buildQuery,
  createKnowledgeFromURL,
  createSession,
  deleteSession,
  generateSessionTitle,
  getCurrentUser,
  getKnowledgeBase,
  getSession,
  knowledgeChat,
  knowledgeChatStream,
  listKnowledgeBases,
  listKnowledgeFiles,
  listSessions,
  loadMessages,
  pinSession,
  request,
  streamRequest,
  unpinSession,
  updateSession,
  upload,
  uploadKnowledgeFile,
};
