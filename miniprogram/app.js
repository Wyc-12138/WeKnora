const { extractImportMaterials, firstImportTarget, savePendingImport } = require("./utils/import-material");

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
  const importId = savePendingImport(materials);
  const target = firstImportTarget(materials);
  if (!importId || !target) return;
  const currentPath = options.path || "";
  if (currentPath === target) return;
  setTimeout(() => {
    wx.redirectTo({
      url: `/${target}?importId=${encodeURIComponent(importId)}`
    });
  }, 0);
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
