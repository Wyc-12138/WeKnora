const PENDING_IMPORT_KEY = "weknora_pending_import";

const FILE_EXTENSIONS = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  epub: "application/epub+zip",
  mhtml: "message/rfc822",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  json: "application/json"
};

function looksLikeURL(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function getFileExtension(name = "") {
  const clean = String(name || "").split("?")[0].split("#")[0];
  const index = clean.lastIndexOf(".");
  if (index < 0 || index === clean.length - 1) return "";
  return clean.slice(index + 1).toLowerCase();
}

function normalizeMaterial(raw = {}) {
  const path = raw.path || raw.filePath || raw.tempFilePath || raw.url || "";
  const name = raw.name || raw.fileName || raw.title || "";
  const type = String(raw.type || raw.materialType || "").toLowerCase();
  const ext = getFileExtension(name || path);

  if (type === "webview" || type === "url" || looksLikeURL(raw.url) || looksLikeURL(path)) {
    const url = raw.url || path;
    return {
      kind: "url",
      source: "wechat_article",
      title: raw.title || name || "Wechat article",
      url,
      raw
    };
  }

  if (path) {
    return {
      kind: "file",
      source: "wechat_file",
      name: name || "wechat-file",
      path,
      size: raw.size || raw.fileSize || 0,
      fileType: ext,
      raw
    };
  }

  return null;
}

function extractForwardMaterials(options = {}) {
  const materials = options.forwardMaterials || options.forwardMaterial || [];
  if (Array.isArray(materials)) {
    return materials.map(normalizeMaterial).filter(Boolean);
  }
  const material = normalizeMaterial(materials);
  return material ? [material] : [];
}

function extractQueryMaterial(options = {}) {
  const query = options.query || {};
  const url = query.url ? decodeURIComponent(query.url) : "";
  const filePath = query.filePath ? decodeURIComponent(query.filePath) : "";
  if (url) {
    return normalizeMaterial({
      type: "url",
      url,
      title: query.title ? decodeURIComponent(query.title) : ""
    });
  }
  if (filePath) {
    return normalizeMaterial({
      type: "file",
      path: filePath,
      name: query.name ? decodeURIComponent(query.name) : ""
    });
  }
  return null;
}

function extractImportMaterials(options = {}) {
  const materials = extractForwardMaterials(options);
  const queryMaterial = extractQueryMaterial(options);
  if (queryMaterial) materials.push(queryMaterial);
  return materials;
}

function savePendingImport(materials) {
  const normalized = Array.isArray(materials) ? materials.filter(Boolean) : [materials].filter(Boolean);
  if (!normalized.length) return "";
  const importId = `imp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  wx.setStorageSync(PENDING_IMPORT_KEY, {
    id: importId,
    createdAt: Date.now(),
    materials: normalized
  });
  return importId;
}

function getPendingImport(importId) {
  const pending = wx.getStorageSync(PENDING_IMPORT_KEY) || null;
  if (!pending || (importId && pending.id !== importId)) return null;
  return pending;
}

function clearPendingImport(importId) {
  const pending = wx.getStorageSync(PENDING_IMPORT_KEY) || null;
  if (!pending || (importId && pending.id !== importId)) return;
  wx.removeStorageSync(PENDING_IMPORT_KEY);
}

module.exports = {
  FILE_EXTENSIONS,
  PENDING_IMPORT_KEY,
  clearPendingImport,
  extractImportMaterials,
  getFileExtension,
  getPendingImport,
  looksLikeURL,
  normalizeMaterial,
  savePendingImport
};
