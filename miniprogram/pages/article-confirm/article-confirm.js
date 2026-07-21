const { getSettings, saveSettings } = require("../../utils/config");
const { createArticleSubmission, listKnowledgeBases } = require("../../utils/request");
const { normalizeList } = require("../../utils/normalize");

const PREVIEW_KEY = "weknora_article_preview";

function normalizeKnowledgeBases(response) {
  return normalizeList(response).filter((item) => item.type !== "faq");
}

Page({
  data: {
    knowledgeBases: [],
    knowledgeBaseNames: [],
    materialType: "指南 / 共识解读",
    note: "",
    preview: {},
    selectedIndex: 0,
    selectedKnowledgeBaseId: "",
    selectedKnowledgeBaseName: "",
    submitting: false,
    title: ""
  },

  onLoad() {
    const stored = wx.getStorageSync(PREVIEW_KEY) || {};
    const preview = stored.preview || {};
    this.setData({
      preview,
      selectedKnowledgeBaseId: stored.knowledgeBaseId || getSettings().selectedKnowledgeBaseId || "",
      title: preview.title || "微信文章"
    });
  },

  onShow() {
    this.loadKnowledgeBases();
  },

  async loadKnowledgeBases() {
    try {
      const response = await listKnowledgeBases();
      const knowledgeBases = normalizeKnowledgeBases(response);
      const knowledgeBaseNames = knowledgeBases.map((item) => item.name || item.id);
      const foundIndex = knowledgeBases.findIndex((item) => item.id === this.data.selectedKnowledgeBaseId);
      const selectedIndex = foundIndex >= 0 ? foundIndex : 0;
      const selected = knowledgeBases[selectedIndex];
      this.setData({
        knowledgeBases,
        knowledgeBaseNames,
        selectedIndex,
        selectedKnowledgeBaseId: selected?.id || "",
        selectedKnowledgeBaseName: selected?.name || selected?.id || ""
      });
    } catch (error) {
      wx.showModal({ title: "知识库加载失败", content: error.message, showCancel: false });
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

  onTitleInput(event) {
    this.setData({ title: event.detail.value });
  },

  onMaterialTypeInput(event) {
    this.setData({ materialType: event.detail.value });
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  async submitDraft() {
    if (this.data.submitting || !this.data.selectedKnowledgeBaseId) return;
    this.setData({ submitting: true });
    try {
      await createArticleSubmission(this.data.selectedKnowledgeBaseId, {
        url: this.data.preview.url,
        title: this.data.title.trim(),
        materialType: this.data.materialType.trim(),
        note: this.data.note.trim(),
        source: this.data.preview.source,
        publishedAt: this.data.preview.published_at,
        summary: this.data.preview.summary,
        coverUrl: this.data.preview.cover_url
      });
      wx.removeStorageSync(PREVIEW_KEY);
      wx.showToast({ title: "已提交草稿", icon: "success" });
      wx.redirectTo({ url: "/pages/index/index" });
    } catch (error) {
      wx.showModal({ title: "提交失败", content: error.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/clip-article/clip-article" }) });
  }
});
