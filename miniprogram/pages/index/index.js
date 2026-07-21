const { saveSettings, getSettings } = require("../../utils/config");
const { listKnowledgeBases, listMobileSubmissions } = require("../../utils/request");
const { formatTime, normalizeList, unwrapData } = require("../../utils/normalize");

const STATUS_TEXT = {
  processing: "处理中",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已驳回",
  failed: "失败",
  withdrawn: "已撤回"
};

function normalizeKnowledgeBases(response) {
  return normalizeList(response).map((item) => ({
    ...item,
    timeText: formatTime(item.updated_at || item.created_at)
  }));
}

function normalizeSubmissions(response) {
  const payload = unwrapData(response);
  const list = Array.isArray(payload?.data) ? payload.data : normalizeList(response);
  return list.map((item) => {
    const fileType = String(item.file_type || "").toUpperCase();
    return {
      ...item,
      displayTitle: item.title || item.file_name || item.source_url || "未命名资料",
      kindText: item.kind === "file" ? "文件" : "公众号",
      fileBadge: fileType || "DOC",
      statusText: STATUS_TEXT[item.status] || item.status || "处理中",
      timeText: formatTime(item.created_at || item.updated_at) || "刚刚"
    };
  });
}

Page({
  data: {
    knowledgeBases: [],
    knowledgeBaseNames: [],
    loading: false,
    needsSettings: false,
    recentSubmissions: [],
    selectedIndex: 0,
    selectedKnowledgeBaseId: "",
    selectedKnowledgeBaseName: "",
    submissionsLoading: false
  },

  onShow() {
    const settings = getSettings();
    const needsSettings = !settings.baseUrl || !settings.apiKey;
    this.setData({ needsSettings });
    if (!needsSettings) {
      this.loadKnowledgeBases();
      this.loadRecentSubmissions();
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

  async loadRecentSubmissions() {
    this.setData({ submissionsLoading: true });
    try {
      const response = await listMobileSubmissions({ page: 1, page_size: 5 });
      this.setData({ recentSubmissions: normalizeSubmissions(response) });
    } catch (error) {
      this.setData({ recentSubmissions: [] });
    } finally {
      this.setData({ submissionsLoading: false });
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
