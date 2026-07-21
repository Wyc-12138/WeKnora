function parseSSE(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  return raw
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = { event: "message", data: "" };
      block.split(/\n/).forEach((line) => {
        if (line.startsWith("event:")) {
          event.event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
          event.data += line.slice(5).trim();
        }
      });
      return event;
    })
    .filter((event) => event.data);
}

function parseSSEBlock(block) {
  const event = { event: "message", data: "" };
  String(block || "")
    .trim()
    .split(/\n/)
    .forEach((line) => {
      if (line.startsWith("event:")) {
        event.event = line.slice(6).trim();
      }
      if (line.startsWith("data:")) {
        event.data += line.slice(5).trim();
      }
    });
  return event.data ? event : null;
}

function createSSEParser(onEvent) {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk || "";
      const blocks = buffer.split(/\n\n+/);
      buffer = blocks.pop() || "";
      blocks.forEach((block) => {
        const event = parseSSEBlock(block);
        if (event) {
          onEvent(event);
        }
      });
    },

    flush() {
      const event = parseSSEBlock(buffer);
      buffer = "";
      if (event) {
        onEvent(event);
      }
    }
  };
}

function collectAnswerFromSSE(raw) {
  return parseSSE(raw).reduce((answer, event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.response_type === "answer" && payload.content) {
        return answer + payload.content;
      }
    } catch (error) {
      return answer;
    }
    return answer;
  }, "");
}

function extractAnswerChunk(event) {
  try {
    const payload = JSON.parse(event.data);
    if (payload.response_type === "answer" && payload.content) {
      return payload.content;
    }
  } catch (error) {
    return "";
  }
  return "";
}

module.exports = {
  collectAnswerFromSSE,
  createSSEParser,
  extractAnswerChunk,
  parseSSE
};
