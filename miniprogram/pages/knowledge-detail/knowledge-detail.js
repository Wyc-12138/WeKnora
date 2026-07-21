const { getSettings, saveSettings } = require("../../utils/config");
const { getKnowledgeBase, listKnowledgeFiles, uploadKnowledgeFile } = require("../../utils/request");
const { formatTime, normalizeList, normalizeTotal, unwrapData } = require("../../utils/normalize");

function decorateKnowledge(item) {
  const status = item.parse_status || item.enable_status || "";
  const failedStatuses = new Set(["failed", "fail", "error"]);
  const displayError = failedStatuses.has(String(status).toLowerCase())
    ? (item.error_message || item.error || item.message || "")
    : "";
  return {
    ...item,
    displayTitle: item.title || item.file_name || item.source || item.id,
    displayType: item.file_type || item.type || "knowledge",
    statusText: status,
    timeText: formatTime(item.updated_at || item.created_at),
    sizeText: item.file_size ? `${Math.ceil(item.file_size / 1024)} KB` : "",
    displayError
  };
}

Page({
  data: {
    id: "",
    knowledgeBase: null,
    files: [],
    loading: false,
    uploading: false,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    uploadErrors: []
  },

  onLoad(options) {
    const id = decodeURIComponent(options.id || "");
    this.setData({ id });
  },

  onShow() {
    if (this.data.id) {
      this.loadAll(true);
    }
  },

  async loadAll(reset = false) {
    const settings = getSettings();
    if (!settings.baseUrl || !settings.apiKey) {
      wx.showModal({
        title: "需要设置",
        content: "请先配置 API Base URL 和 API Key。",
        showCancel: false
      });
      return;
    }

    const nextPage = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const [kbResponse, filesResponse] = await Promise.all([
        getKnowledgeBase(this.data.id),
        listKnowledgeFiles(this.data.id, { page: nextPage, page_size: this.data.pageSize })
      ]);
      const knowledgeBase = unwrapData(kbResponse);
      const nextFiles = normalizeList(filesResponse).map(decorateKnowledge);
      const files = reset ? nextFiles : this.data.files.concat(nextFiles);
      const total = normalizeTotal(filesResponse, files.length);
      this.setData({
        knowledgeBase: {
          ...knowledgeBase,
          timeText: formatTime(knowledgeBase?.updated_at || knowledgeBase?.created_at)
        },
        files,
        page: nextPage,
        total,
        hasMore: files.length < total
      });
      if (knowledgeBase?.id) {
        saveSettings({ selectedKnowledgeBaseId: knowledgeBase.id });
      }
    } catch (error) {
      wx.showModal({ title: "加载失败", content: error.message, showCancel: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadAll(false);
  },

  chooseAndUpload() {
    if (!this.data.id || this.data.uploading) return;

    wx.chooseMessageFile({
      count: 9,
      type: "file",
      success: async (result) => {
        const files = result.tempFiles || [];
        if (!files.length) return;
        const uploadErrors = [];
        let uploadedCount = 0;
        this.setData({ uploading: true, uploadErrors: [] });
        try {
          for (const file of files) {
            try {
              await uploadKnowledgeFile(this.data.id, file);
              uploadedCount += 1;
            } catch (error) {
              uploadErrors.push(`${file.name || file.fileName || "文件"}: ${error.message}`);
            }
          }
          if (uploadedCount > 0) {
            wx.showToast({ title: "已上传", icon: "success" });
            this.loadAll(true);
          }
          if (uploadErrors.length) {
            this.setData({ uploadErrors });
          }
        } finally {
          this.setData({ uploading: false });
        }
      }
    });
  }
});
