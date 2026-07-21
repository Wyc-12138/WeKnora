const { getSettings } = require("../../utils/config");
const { clearPendingImport, getPendingImport, looksLikeURL } = require("../../utils/import-material");

const RECENT_KEY = "weknora_recent_article_previews";
const PREVIEW_KEY = "weknora_article_preview";

Page({
  data: {
    importId: "",
    importConsumed: false,
    identifying: false,
    readingClipboard: false,
    recent: [],
    url: ""
  },

  onLoad(options = {}) {
    const importId = decodeURIComponent(options.importId || "");
    this.setData({ importId });
    this.consumePendingArticle(importId);
  },

  onShow() {
    this.setData({ recent: wx.getStorageSync(RECENT_KEY) || [] });
    if (!this.data.importConsumed) {
      this.consumePendingArticle(this.data.importId);
    }
  },

  consumePendingArticle(importId = "") {
    const pending = getPendingImport(importId);
    const material = (pending?.materials || []).find((item) => item.kind === "url");
    if (!material) return;

    const url = String(material.url || "").trim();
    this.setData({
      importId: pending.id || importId || "",
      importConsumed: true,
      url
    });

    if (looksLikeURL(url)) {
      setTimeout(() => this.identifyArticle({ fromImport: true }), 0);
    } else {
      wx.showToast({ title: "Paste article URL", icon: "none" });
    }
  },

  onUrlInput(event) {
    this.setData({ url: event.detail.value });
  },

  clearUrl() {
    this.setData({ url: "" });
  },

  readClipboard() {
    if (this.data.readingClipboard) return;
    this.setData({ readingClipboard: true });
    wx.getClipboardData({
      success: (res) => {
        this.setData({ url: res.data || "" });
      },
      fail: (error) => {
        wx.showToast({ title: error.errMsg || "Read failed", icon: "none" });
      },
      complete: () => {
        this.setData({ readingClipboard: false });
      }
    });
  },

  useRecent(event) {
    this.setData({ url: event.currentTarget.dataset.url || "" });
  },

  async identifyArticle(options = {}) {
    const settings = getSettings();
    const knowledgeBaseId = settings.selectedKnowledgeBaseId;
    const url = this.data.url.trim();

    if (!knowledgeBaseId) {
      wx.showToast({ title: "Select a knowledge base first", icon: "none" });
      return;
    }
    if (!url) return;

    this.setData({ identifying: true });
    try {
      const preview = {
        url,
        title: "微信文章",
        source: "微信公众号",
        published_at: "",
        summary: "链接已读取，提交后将直接进入知识库处理流程。",
        cover_url: ""
      };
      wx.setStorageSync(PREVIEW_KEY, {
        knowledgeBaseId,
        preview
      });
      clearPendingImport(this.data.importId);
      this.saveRecent(preview);
      wx.navigateTo({ url: "/pages/article-confirm/article-confirm" });
    } catch (error) {
      if (options.fromImport) {
        wx.showToast({ title: "URL filled", icon: "none" });
      } else {
        wx.showModal({ title: "识别失败", content: error.message, showCancel: false });
      }
    } finally {
      this.setData({ identifying: false });
    }
  },

  saveRecent(preview) {
    const item = {
      title: preview.title || "WeChat article",
      url: preview.url || this.data.url.trim(),
      date: preview.published_at || "Just now"
    };
    const next = [item].concat((wx.getStorageSync(RECENT_KEY) || []).filter((old) => old.url !== item.url)).slice(0, 5);
    wx.setStorageSync(RECENT_KEY, next);
    this.setData({ recent: next });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/index/index" }) });
  }
});
