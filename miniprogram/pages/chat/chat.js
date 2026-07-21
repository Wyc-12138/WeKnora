const { getSettings, saveSettings } = require("../../utils/config");
const {
  createSession,
  getSession,
  knowledgeChatStream,
  loadMessages
} = require("../../utils/request");
const { parseMarkdownToNodes } = require("../../utils/markdown");
const { normalizeMessages, unwrapData } = require("../../utils/normalize");

function getFirstSessionKnowledgeBaseId(session) {
  const state = session?.last_request_state || session?.agent_config || {};
  const knowledgeBaseIds = Array.isArray(state.knowledge_base_ids) ? state.knowledge_base_ids : [];
  return knowledgeBaseIds[0] || "";
}

function withMarkdownNodes(message) {
  if (!message || message.role !== "assistant") return message;
  return {
    ...message,
    markdownNodes: parseMarkdownToNodes(message.content)
  };
}

function pickSessionId(response) {
  const payload = unwrapData(response);
  return payload?.id
    || payload?.session_id
    || payload?.session?.id
    || response?.id
    || response?.session_id
    || response?.session?.id
    || response?.data?.id
    || response?.data?.session_id
    || response?.data?.session?.id
    || "";
}

Page({
  data: {
    bottomAnchor: "bottom-anchor",
    historyLoading: false,
    loading: false,
    messages: [],
    query: "",
    sessionId: ""
  },

  onLoad(options) {
    if (options.sessionId) {
      saveSettings({ activeSessionId: decodeURIComponent(options.sessionId) });
    }
  },

  onShow() {
    const settings = getSettings();
    if (settings.activeSessionId && settings.activeSessionId !== this.data.sessionId) {
      this.switchSession(settings.activeSessionId);
    }
  },

  onQueryInput(event) {
    this.setData({ query: event.detail.value });
  },

  async ensureSession() {
    if (this.data.sessionId) {
      return this.data.sessionId;
    }

    const response = await createSession("");
    const sessionId = pickSessionId(response);
    if (!sessionId) {
      throw new Error("Session API did not return a session id.");
    }
    saveSettings({ activeSessionId: sessionId });
    this.setData({ sessionId });
    return sessionId;
  },

  async loadHistory() {
    if (!this.data.sessionId) return;
    this.setData({ historyLoading: true });
    try {
      const response = await loadMessages(this.data.sessionId, 50);
      this.setData({ messages: normalizeMessages(response).map(withMarkdownNodes) });
    } catch (error) {
      wx.showModal({
        title: "History loading failed",
        content: error.message,
        showCancel: false
      });
    } finally {
      this.setData({ historyLoading: false });
    }
  },

  async newSession() {
    saveSettings({ activeSessionId: "" });
    this.setData({ sessionId: "", messages: [], query: "" });
  },

  onOpenSession(event) {
    const sessionId = event.detail?.sessionId;
    if (!sessionId) return;
    this.switchSession(sessionId);
  },

  openKnowledge() {
    wx.redirectTo({ url: "/pages/index/index" });
  },

  async ask() {
    const query = this.data.query.trim();
    if (!query || this.data.loading) return;

    const previousMessages = this.data.messages;
    let assistantId = "";
    this.setData({ loading: true, query: "" });
    try {
      const sessionId = await this.ensureSession();
      const settings = getSettings();
      const now = Date.now();
      assistantId = `assistant-${now}`;
      const nextMessages = this.data.messages.concat([
        {
          id: `user-${now}`,
          role: "user",
          content: query
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          markdownNodes: []
        }
      ]);
      this.setData({ messages: nextMessages });
      this.scrollToBottom();

      await knowledgeChatStream(sessionId, query, settings.selectedKnowledgeBaseId, (_chunk, answer) => {
        const messages = this.data.messages.map((message) => (
          message.id === assistantId
            ? withMarkdownNodes({ ...message, content: answer })
            : message
        ));
        this.setData({ messages });
        this.scrollToBottom();
      });
    } catch (error) {
      const assistantMessage = this.data.messages.find((message) => message.id === assistantId);
      if (!assistantMessage || !assistantMessage.content) {
        this.setData({ messages: previousMessages, query });
      }
      wx.showModal({
        title: "Question failed",
        content: error.message,
        showCancel: false
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async switchSession(sessionId) {
    this.setData({ sessionId, messages: [], query: "" });
    await this.hydrateSessionState(sessionId);
    this.loadHistory();
  },

  async hydrateSessionState(sessionId) {
    try {
      const response = await getSession(sessionId);
      const session = unwrapData(response);
      const knowledgeBaseId = getFirstSessionKnowledgeBaseId(session);
      if (knowledgeBaseId) {
        saveSettings({ selectedKnowledgeBaseId: knowledgeBaseId });
      }
    } catch (error) {
      // Older sessions may not carry last_request_state; history can still load.
    }
  },

  scrollToBottom() {
    this.setData({ bottomAnchor: `bottom-${Date.now()}` });
  }
});
