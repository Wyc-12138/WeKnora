const { saveSettings } = require("../../utils/config");
const { getCurrentUser, listSessions } = require("../../utils/request");
const { formatTime, normalizeList, pickTitle } = require("../../utils/normalize");

const DEFAULT_ACCOUNT_NAME = "WeKnora";

function decorateSession(item) {
  return {
    ...item,
    displayTitle: pickTitle(item, "\u65b0\u4f1a\u8bdd"),
    timeText: formatTime(item.updated_at || item.created_at)
  };
}

function firstNonEmpty(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : "";
}

function pickPayload(response) {
  if (!response || typeof response !== "object") return {};
  if (response.data && typeof response.data === "object") return response.data;
  return response;
}

function normalizeAccountProfile(response) {
  const payload = pickPayload(response);
  const user = payload.user || payload.profile || payload.account || payload;
  const tenant = payload.tenant || payload.current_tenant || payload.selected_tenant || {};
  const name = firstNonEmpty(
    user.nickname,
    user.name,
    user.username,
    user.email,
    tenant.name,
    payload.tenant_name,
    DEFAULT_ACCOUNT_NAME
  );
  const avatar = firstNonEmpty(user.avatar, user.avatar_url, user.picture);
  const initial = (name || DEFAULT_ACCOUNT_NAME).trim().slice(0, 1).toUpperCase();

  return {
    accountName: name || DEFAULT_ACCOUNT_NAME,
    accountAvatar: avatar,
    accountInitial: initial || "W"
  };
}

Component({
  properties: {
    activeKey: {
      type: String,
      value: ""
    },
    title: {
      type: String,
      value: "WeKnora"
    },
    subtitle: {
      type: String,
      value: ""
    },
    showNew: {
      type: Boolean,
      value: true
    }
  },

  data: {
    drawerVisible: false,
    open: false,
    statusBarHeight: 20,
    sessions: [],
    sessionLoading: false,
    sessionKeyword: "",
    accountName: DEFAULT_ACCOUNT_NAME,
    accountAvatar: "",
    accountInitial: "W",
    accountLoaded: false
  },

  lifetimes: {
    attached() {
      try {
        const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
        this.setData({ statusBarHeight: info.statusBarHeight || 20 });
      } catch (error) {
        this.setData({ statusBarHeight: 20 });
      }
    },

    detached() {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
      }
    }
  },

  methods: {
    openDrawer() {
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
      }
      this.setData({ drawerVisible: true });
      setTimeout(() => {
        this.setData({ open: true });
      }, 20);
      this.loadAccount();
      this.loadSessions();
    },

    closeDrawer() {
      this.setData({ open: false });
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
      }
      this.closeTimer = setTimeout(() => {
        this.setData({ drawerVisible: false });
      }, 260);
    },

    stopPropagation() {},

    async loadAccount() {
      if (this.data.accountLoaded) return;
      try {
        const response = await getCurrentUser();
        this.setData({
          ...normalizeAccountProfile(response),
          accountLoaded: true
        });
      } catch (error) {
        this.setData({
          accountName: DEFAULT_ACCOUNT_NAME,
          accountAvatar: "",
          accountInitial: "W",
          accountLoaded: true
        });
      }
    },

    async loadSessions(keyword = this.data.sessionKeyword) {
      this.setData({ sessionLoading: true });
      try {
        const response = await listSessions({
          page: 1,
          page_size: 30,
          keyword: (keyword || "").trim()
        });
        this.setData({ sessions: normalizeList(response).map(decorateSession) });
      } catch (error) {
        this.setData({ sessions: [] });
      } finally {
        this.setData({ sessionLoading: false });
      }
    },

    onSearchInput(event) {
      const sessionKeyword = event.detail.value;
      this.setData({ sessionKeyword });
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
      this.searchTimer = setTimeout(() => {
        this.loadSessions(sessionKeyword);
      }, 300);
    },

    goKnowledge() {
      this.closeAndRedirect("/pages/index/index");
    },

    goSettings() {
      this.closeAndRedirect("/pages/settings/settings");
    },

    closeAndRedirect(url) {
      this.closeDrawer();
      setTimeout(() => {
        wx.redirectTo({ url });
      }, 260);
    },

    newChat() {
      saveSettings({ activeSessionId: "" });
      this.closeDrawer();
      if (this.data.activeKey === "chat") {
        setTimeout(() => {
          this.triggerEvent("newchat");
        }, 260);
        return;
      }
      setTimeout(() => {
        wx.redirectTo({ url: "/pages/chat/chat" });
      }, 260);
    },

    openSession(event) {
      const sessionId = event.currentTarget.dataset.id;
      if (!sessionId) return;
      saveSettings({ activeSessionId: sessionId });
      this.closeDrawer();
      if (this.data.activeKey === "chat") {
        setTimeout(() => {
          this.triggerEvent("opensession", { sessionId });
        }, 260);
        return;
      }
      setTimeout(() => {
        wx.redirectTo({ url: "/pages/chat/chat" });
      }, 260);
    }
  }
});
