function unwrapData(response) {
  if (response && Object.prototype.hasOwnProperty.call(response, "data")) {
    return response.data;
  }
  return response;
}

function normalizeList(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.data?.list)) return response.data.list;
  if (Array.isArray(response?.list)) return response.list;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.knowledge_bases)) return response.knowledge_bases;
  if (Array.isArray(response?.messages)) return response.messages;
  return [];
}

function normalizeTotal(response, fallbackLength = 0) {
  return response?.total || response?.data?.total || response?.pagination?.total || fallbackLength;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pickTitle(item, fallback = "未命名") {
  return item?.title || item?.name || item?.file_name || item?.id || fallback;
}

function normalizeMessage(message) {
  const role = message.role || message.sender || message.message_type || message.type || "";
  const content = message.content || message.answer || message.query || message.text || "";
  const isUser = role === "user" || role === "human" || message.is_user;
  return {
    id: message.id || `${role}-${message.created_at || Date.now()}`,
    role: isUser ? "user" : "assistant",
    content,
    created_at: message.created_at || message.updated_at || "",
    timeText: formatTime(message.created_at || message.updated_at)
  };
}

function normalizeMessages(response) {
  return normalizeList(response)
    .map(normalizeMessage)
    .filter((message) => message.content);
}

module.exports = {
  formatTime,
  normalizeList,
  normalizeMessages,
  normalizeTotal,
  pickTitle,
  unwrapData
};
