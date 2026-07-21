const { extractImportMaterials, savePendingImport } = require("./utils/import-material");

function ensureSettings() {
  const settings = wx.getStorageSync("weknora_settings");
  if (!settings) {
    wx.setStorageSync("weknora_settings", {
      baseUrl: "http://localhost:8080",
      apiKey: "",
      selectedKnowledgeBaseId: "",
      activeSessionId: ""
    });
  }
}

function routeImportMaterials(options) {
  const materials = extractImportMaterials(options);
  if (!materials.length) return;
  savePendingImport(materials);
}

App({
  onLaunch(options = {}) {
    ensureSettings();
    routeImportMaterials(options);
  },

  onShow(options = {}) {
    routeImportMaterials(options);
  }
});
