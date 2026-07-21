const { getSettings, saveSettings } = require("../../utils/config");

Page({
  data: {
    baseUrl: "",
    apiKey: "",
    returnTo: "",
    importId: ""
  },

  onLoad(options = {}) {
    this.setData({
      returnTo: decodeURIComponent(options.returnTo || ""),
      importId: decodeURIComponent(options.importId || "")
    });
  },

  onShow() {
    const settings = getSettings();
    this.setData({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey
    });
  },

  onBaseUrlInput(event) {
    this.setData({ baseUrl: event.detail.value });
  },

  onApiKeyInput(event) {
    this.setData({ apiKey: event.detail.value });
  },

  save() {
    saveSettings({
      baseUrl: this.data.baseUrl,
      apiKey: this.data.apiKey
    });
    wx.showToast({ title: "已保存", icon: "success" });
    if (this.data.returnTo === "import-confirm") {
      const query = this.data.importId ? `?importId=${encodeURIComponent(this.data.importId)}` : "";
      wx.redirectTo({ url: `/pages/import-confirm/import-confirm${query}` });
    }
  }
});
