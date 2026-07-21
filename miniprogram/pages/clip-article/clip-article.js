const { getSettings } = require("../../utils/config");
const { previewMobileArticle } = require("../../utils/request");
const { unwrapData } = require("../../utils/normalize");

const RECENT_KEY = "weknora_recent_article_previews";
const PREVIEW_KEY = "weknora_article_preview";

Page({
  data: {
    identifying: false,
    readingClipboard: false,
    recent: [],
    url: ""
  },

  onShow() {
    this.setData({ recent: wx.getStorageSync(RECENT_KEY) || [] });
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
        wx.showToast({ title: error.errMsg || "读取失败", icon: "none" });
      },
      complete: () => {
        this.setData({ readingClipboard: false });
      }
    });
  },

  useRecent(event) {
    this.setData({ url: event.currentTarget.dataset.url || "" });
  },

  async identifyArticle() {
    const settings = getSettings();
    const knowledgeBaseId = settings.selectedKnowledgeBaseId;
    const url = this.data.url.trim();
    if (!knowledgeBaseId) {
      wx.showToast({ title: "请先在首页选择知识库", icon: "none" });
      return;
    }
    if (!url) return;

    this.setData({ identifying: true });
    try {
      const response = await previewMobileArticle(knowledgeBaseId, url);
      const preview = unwrapData(response);
      wx.setStorageSync(PREVIEW_KEY, {
        knowledgeBaseId,
        preview
      });
      this.saveRecent(preview);
      wx.navigateTo({ url: "/pages/article-confirm/article-confirm" });
    } catch (error) {
      wx.showModal({ title: "识别失败", content: error.message, showCancel: false });
    } finally {
      this.setData({ identifying: false });
    }
  },

  saveRecent(preview) {
    const item = {
      title: preview.title || "微信文章",
      url: preview.url || this.data.url.trim(),
      date: preview.published_at || "刚刚"
    };
    const next = [item].concat((wx.getStorageSync(RECENT_KEY) || []).filter((old) => old.url !== item.url)).slice(0, 5);
    wx.setStorageSync(RECENT_KEY, next);
    this.setData({ recent: next });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/index/index" }) });
  }
});
