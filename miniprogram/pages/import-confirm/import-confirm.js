const { getSettings, saveSettings } = require("../../utils/config");
const { createKnowledgeFromURL, listKnowledgeBases, uploadKnowledgeFile } = require("../../utils/request");
const { clearPendingImport, getPendingImport } = require("../../utils/import-material");
const { formatTime, normalizeList } = require("../../utils/normalize");

function normalizeKnowledgeBases(response) {
  return normalizeList(response).map((item) => ({
    ...item,
    timeText: formatTime(item.updated_at || item.created_at)
  }));
}

function displayMaterial(material) {
  if (!material) return {};
  if (material.kind === "url") {
    return {
      ...material,
      displayType: "Wechat article / web link",
      displayTitle: material.title || material.url || "Untitled link",
      displayMeta: material.url || "No URL was provided. Paste the article URL below.",
      needsUrl: !material.url
    };
  }
  return {
    ...material,
    displayType: "Wechat file",
    displayTitle: material.name || "Untitled file",
    displayMeta: material.size ? `${Math.ceil(material.size / 1024)} KB` : material.fileType || ""
  };
}

Page({
  data: {
    importId: "",
    materials: [],
    knowledgeBases: [],
    knowledgeBaseNames: [],
    selectedIndex: 0,
    selectedKnowledgeBaseId: "",
    selectedKnowledgeBaseName: "",
    needsSettings: false,
    loading: false,
    importing: false,
    articleUrl: "",
    articleUrls: {},
    statusMessage: "",
    errorMessage: ""
  },

  onLoad(options = {}) {
    const importId = decodeURIComponent(options.importId || "");
    this.setData({ importId });
    this.loadPendingImport(importId);
  },

  onShow() {
    if (!this.data.materials.length) {
      this.loadPendingImport(this.data.importId);
    }
    const settings = getSettings();
    const needsSettings = !settings.baseUrl || !settings.apiKey;
    this.setData({ needsSettings });
    if (!needsSettings) {
      this.loadKnowledgeBases();
    }
  },

  loadPendingImport(importId = "") {
    const pending = getPendingImport(importId);
    const materials = (pending?.materials || []).map(displayMaterial);
    const firstURL = materials.find((item) => item.kind === "url")?.url || "";
    const articleUrls = {};
    materials.forEach((material, index) => {
      if (material.kind === "url" && material.url) {
        articleUrls[index] = material.url;
      }
    });
    this.setData({
      importId: pending?.id || importId || "",
      materials,
      articleUrl: firstURL || this.data.articleUrl,
      articleUrls,
      errorMessage: materials.length ? "" : "No importable Wechat shared content was found."
    });
  },

  async loadKnowledgeBases() {
    this.setData({ loading: true, errorMessage: "" });
    try {
      const response = await listKnowledgeBases();
      const knowledgeBases = normalizeKnowledgeBases(response).filter((item) => item.type !== "faq");
      const knowledgeBaseNames = knowledgeBases.map((item) => item.name || item.id);
      const settings = getSettings();
      const foundIndex = knowledgeBases.findIndex((item) => item.id === settings.selectedKnowledgeBaseId);
      const selectedIndex = foundIndex >= 0 ? foundIndex : 0;
      const selected = knowledgeBases[selectedIndex];
      this.setData({
        knowledgeBases,
        knowledgeBaseNames,
        selectedIndex,
        selectedKnowledgeBaseId: selected?.id || "",
        selectedKnowledgeBaseName: selected?.name || "",
        statusMessage: knowledgeBases.length ? `Loaded ${knowledgeBases.length} document knowledge bases` : "No document knowledge base is available"
      });
      if (selected?.id) {
        saveSettings({ selectedKnowledgeBaseId: selected.id });
      }
    } catch (error) {
      this.setData({ errorMessage: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onKnowledgeBaseChange(event) {
    const selectedIndex = Number(event.detail.value);
    const selected = this.data.knowledgeBases[selectedIndex];
    if (!selected) return;
    saveSettings({ selectedKnowledgeBaseId: selected.id });
    this.setData({
      selectedIndex,
      selectedKnowledgeBaseId: selected.id,
      selectedKnowledgeBaseName: selected.name || selected.id
    });
  },

  onArticleUrlInput(event) {
    const index = event.currentTarget?.dataset?.index;
    if (index === undefined || index === null || index === "") {
      this.setData({ articleUrl: event.detail.value });
      return;
    }
    this.setData({
      [`articleUrls.${index}`]: event.detail.value,
      articleUrl: event.detail.value
    });
  },

  openSettings() {
    const query = this.data.importId
      ? `?returnTo=${encodeURIComponent("import-confirm")}&importId=${encodeURIComponent(this.data.importId)}`
      : "?returnTo=import-confirm";
    wx.redirectTo({ url: `/pages/settings/settings${query}` });
  },

  async confirmImport() {
    if (this.data.importing || !this.data.selectedKnowledgeBaseId || !this.data.materials.length) return;

    this.setData({ importing: true, errorMessage: "", statusMessage: "Importing..." });
    const failures = [];
    let successCount = 0;

    for (let index = 0; index < this.data.materials.length; index += 1) {
      const material = this.data.materials[index];
      try {
        if (material.kind === "url") {
          const url = (material.url || this.data.articleUrls[index] || "").trim();
          if (!url) {
            throw new Error("No article URL was provided. Paste the article URL and try again.");
          }
          await createKnowledgeFromURL(this.data.selectedKnowledgeBaseId, url, {
            title: material.title || material.displayTitle,
            enableMultimodel: false
          });
        } else {
          await uploadKnowledgeFile(this.data.selectedKnowledgeBaseId, material);
        }
        successCount += 1;
      } catch (error) {
        failures.push(`${material.displayTitle || material.name || material.url}: ${error.message}`);
      }
    }

    this.setData({ importing: false });

    if (failures.length) {
      this.setData({
        errorMessage: failures.join("\n"),
        statusMessage: successCount ? `Imported ${successCount} item(s), ${failures.length} failed` : "Import failed"
      });
      return;
    }

    clearPendingImport(this.data.importId);
    wx.showToast({ title: "Imported", icon: "success" });
    wx.redirectTo({
      url: `/pages/knowledge-detail/knowledge-detail?id=${encodeURIComponent(this.data.selectedKnowledgeBaseId)}`
    });
  }
});
