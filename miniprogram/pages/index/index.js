const { saveSettings, getSettings } = require("../../utils/config");
const { listKnowledgeBases } = require("../../utils/request");
const { formatTime, normalizeList } = require("../../utils/normalize");

function normalizeKnowledgeBases(response) {
  return normalizeList(response).map((item) => ({
    ...item,
    timeText: formatTime(item.updated_at || item.created_at)
  }));
}

Page({
  data: {
    knowledgeBases: [],
    knowledgeBaseNames: [],
    loading: false,
    needsSettings: false,
    selectedIndex: 0,
    selectedKnowledgeBaseId: "",
    selectedKnowledgeBaseName: ""
  },

  onShow() {
    const settings = getSettings();
    const needsSettings = !settings.baseUrl || !settings.apiKey;
    this.setData({ needsSettings });
    if (!needsSettings) {
      this.loadKnowledgeBases();
    }
  },

  onKnowledgeBaseChange(event) {
    this.selectKnowledgeBase(Number(event.detail.value));
  },

  selectKnowledgeBase(selectedIndex) {
    const selected = this.data.knowledgeBases[selectedIndex];
    if (!selected) return;
    saveSettings({ selectedKnowledgeBaseId: selected.id });
    this.setData({
      selectedIndex,
      selectedKnowledgeBaseId: selected.id,
      selectedKnowledgeBaseName: selected.name || selected.id
    });
  },

  async loadKnowledgeBases() {
    this.setData({ loading: true });
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
        selectedKnowledgeBaseName: selected?.name || ""
      });
      if (selected?.id) {
        saveSettings({ selectedKnowledgeBaseId: selected.id });
      }
    } catch (error) {
      wx.showModal({ title: "加载知识库失败", content: error.message, showCancel: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  openClipArticle() {
    if (!this.ensureReady()) return;
    wx.navigateTo({ url: "/pages/clip-article/clip-article" });
  },

  openUpload() {
    if (!this.ensureReady()) return;
    wx.navigateTo({ url: "/pages/upload-confirm/upload-confirm" });
  },

  ensureReady() {
    if (this.data.needsSettings) {
      this.openSettings();
      return false;
    }
    if (!this.data.selectedKnowledgeBaseId) {
      wx.showToast({ title: "请先选择知识库", icon: "none" });
      return false;
    }
    return true;
  },

  goChat() {
    wx.redirectTo({ url: "/pages/chat/chat" });
  },

  openSettings() {
    wx.redirectTo({ url: "/pages/settings/settings" });
  }
});
