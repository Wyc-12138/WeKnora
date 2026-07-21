const { getSettings, saveSettings } = require("../../utils/config");
const { listKnowledgeBases, uploadMobileSubmissionFile } = require("../../utils/request");
const { normalizeList } = require("../../utils/normalize");

function normalizeKnowledgeBases(response) {
  return normalizeList(response).filter((item) => item.type !== "faq");
}

function getExt(name = "") {
  const clean = String(name).split("?")[0].split("#")[0];
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index + 1).toLowerCase() : "";
}

function formatSize(size = 0) {
  if (!size) return "";
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(size / 1024)} KB`;
}

Page({
  data: {
    file: {},
    fileBadge: "DOC",
    fileMeta: "PDF / Word",
    knowledgeBases: [],
    knowledgeBaseNames: [],
    materialType: "指南 / 共识",
    note: "",
    selectedIndex: 0,
    selectedKnowledgeBaseId: "",
    selectedKnowledgeBaseName: "",
    submitting: false,
    title: ""
  },

  onLoad() {
    this.setData({ selectedKnowledgeBaseId: getSettings().selectedKnowledgeBaseId || "" });
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

  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["pdf", "doc", "docx"],
      success: (result) => {
        const file = (result.tempFiles || [])[0];
        if (!file) return;
        const ext = getExt(file.name || file.fileName);
        const title = this.data.title || String(file.name || file.fileName || "").replace(/\.[^.]+$/, "");
        this.setData({
          file,
          fileBadge: ext ? ext.toUpperCase() : "DOC",
          fileMeta: [ext ? ext.toUpperCase() : "", formatSize(file.size)].filter(Boolean).join(" · ") || "已选择",
          title
        });
      }
    });
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
    if (this.data.submitting || !this.data.file.path || !this.data.selectedKnowledgeBaseId) return;
    this.setData({ submitting: true });
    try {
      await uploadMobileSubmissionFile(this.data.selectedKnowledgeBaseId, this.data.file, {
        title: this.data.title.trim(),
        materialType: this.data.materialType.trim(),
        note: this.data.note.trim()
      });
      wx.showToast({ title: "已提交草稿", icon: "success" });
      wx.redirectTo({ url: "/pages/index/index" });
    } catch (error) {
      wx.showModal({ title: "提交失败", content: error.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/index/index" }) });
  }
});
