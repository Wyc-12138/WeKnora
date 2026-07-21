function readBraceGroup(source, openIndex) {
  if (source[openIndex] !== "{") return null;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return {
        value: source.slice(openIndex + 1, index),
        end: index + 1
      };
    }
  }
  return null;
}

function replaceLatexFractions(text) {
  const source = String(text || "");
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const fracIndex = source.indexOf("\\frac", cursor);
    if (fracIndex < 0) {
      output += source.slice(cursor);
      break;
    }

    output += source.slice(cursor, fracIndex);
    let index = fracIndex + "\\frac".length;
    while (source[index] === " ") index += 1;
    const numerator = readBraceGroup(source, index);
    if (!numerator) {
      output += "frac";
      cursor = index;
      continue;
    }
    index = numerator.end;
    while (source[index] === " ") index += 1;
    const denominator = readBraceGroup(source, index);
    if (!denominator) {
      output += `(${numerator.value})/`;
      cursor = index;
      continue;
    }
    output += `(${numerator.value})/(${denominator.value})`;
    cursor = denominator.end;
  }

  return output;
}

const GREEK_COMMANDS = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  theta: "theta",
  lambda: "lambda",
  mu: "mu",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  phi: "phi",
  varphi: "phi",
  omega: "omega",
  Delta: "Delta",
  Theta: "Theta",
  Lambda: "Lambda",
  Sigma: "Sigma",
  Phi: "Phi",
  Omega: "Omega"
};

const SUBSCRIPT_CHARS = {
  0: "0",
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  a: "a",
  e: "e",
  h: "h",
  i: "i",
  j: "j",
  k: "k",
  l: "l",
  m: "m",
  n: "n",
  o: "o",
  p: "p",
  r: "r",
  s: "s",
  t: "t",
  u: "u",
  v: "v",
  x: "x"
};

const SUPERSCRIPT_CHARS = {
  0: "0",
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  "+": "+",
  "-": "-",
  "=": "=",
  n: "n",
  i: "i"
};

function toCompactScript(value, map) {
  return String(value || "")
    .split("")
    .map((char) => map[char] || char)
    .join("");
}

function commandReplacement(command) {
  if (GREEK_COMMANDS[command]) return GREEK_COMMANDS[command];
  const replacements = {
    sum: "sum",
    prod: "prod",
    min: "min",
    max: "max",
    lim: "lim",
    log: "log",
    ln: "ln",
    sin: "sin",
    cos: "cos",
    tan: "tan",
    exp: "exp",
    in: " in ",
    notin: " not in ",
    leq: "<=",
    geq: ">=",
    neq: "!=",
    approx: "~=",
    sim: "~",
    to: "->",
    rightarrow: "->",
    leftarrow: "<-",
    leftrightarrow: "<->",
    pm: "+/-",
    cdot: " x ",
    times: " x ",
    dots: "...",
    ldots: "...",
    cdots: "...",
    quad: " ",
    qquad: " "
  };
  return replacements[command] || command;
}

function normalizeLatexCommands(text) {
  return String(text || "")
    .replace(/\\(?:mathrm|mathbf|mathit|text|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt($1)")
    .replace(/\\(?:hat|bar|overline|tilde)\s*\{?([A-Za-z0-9])\}?/g, "$1")
    .replace(/\\begin\s*\{([^{}]+)\}/g, "begin $1")
    .replace(/\\end\s*\{([^{}]+)\}/g, "end $1")
    .replace(/\\\\/g, "; ")
    .replace(/&/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_match, command) => commandReplacement(command));
}

function compactLooseScripts(text) {
  return String(text || "")
    .replace(/_\{([^{}]+)\}/g, (_match, value) => toCompactScript(value, SUBSCRIPT_CHARS))
    .replace(/\^\{([^{}]+)\}/g, (_match, value) => toCompactScript(value, SUPERSCRIPT_CHARS))
    .replace(/_([A-Za-z0-9])/g, (_match, value) => toCompactScript(value, SUBSCRIPT_CHARS))
    .replace(/\^([A-Za-z0-9+\-=])/g, (_match, value) => toCompactScript(value, SUPERSCRIPT_CHARS));
}

function normalizeLooseLatexText(text) {
  const source = replaceLatexFractions(text);
  return compactLooseScripts(normalizeLatexCommands(source));
}

function textNode(text) {
  return { type: "text", text: normalizeLooseLatexText(text) };
}

function rawTextNode(text) {
  return { type: "text", text: String(text || "") };
}

function element(name, style, children = [], attrs = {}) {
  return {
    name,
    attrs: {
      ...(style ? { style } : {}),
      ...attrs
    },
    children
  };
}

function isSafeUrl(url) {
  return /^(https?:|data:image\/)/i.test(String(url || "").trim());
}

function normalizeMathText(text) {
  return replaceLatexFractions(text)
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/\\(?:mathrm|mathbf|mathit|text|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt($1)")
    .replace(/\\(?:hat|bar|overline|tilde)\s*\{?([A-Za-z0-9])\}?/g, "$1")
    .replace(/\\begin\s*\{([^{}]+)\}/g, "begin $1")
    .replace(/\\end\s*\{([^{}]+)\}/g, "end $1")
    .replace(/\\\\/g, "; ")
    .replace(/&/g, " ")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\\,/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_match, command) => commandReplacement(command))
    .replace(/\s+/g, " ")
    .trim();
}

function parseMathInline(text) {
  const source = normalizeMathText(text);
  const nodes = [];
  const tokenRegex = /([_^])(?:\{([^}]+)\}|([A-Za-z0-9+\-=]+))/g;
  let cursor = 0;
  let match;

  while ((match = tokenRegex.exec(source))) {
    if (match.index > cursor) {
      nodes.push(textNode(source.slice(cursor, match.index)));
    }
    const tag = match[1] === "_" ? "sub" : "sup";
    nodes.push(element(tag, "font-size:0.72em;line-height:0;", [textNode(match[2] || match[3] || "")]));
    cursor = match.index + match[0].length;
  }

  if (cursor < source.length) {
    nodes.push(textNode(source.slice(cursor)));
  }

  return nodes.length ? nodes : [textNode(source)];
}

function findNextInlineToken(text, start) {
  const patterns = [
    { type: "image", regex: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g },
    { type: "link", regex: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g },
    { type: "code", regex: /`([^`]+)`/g },
    { type: "math", regex: /\\\(([^]*?)\\\)|\\\[([^]*?)\\\]|\$([^$\n]+)\$/g },
    { type: "bold", regex: /\*\*([\s\S]+?)\*\*/g },
    { type: "strike", regex: /~~([\s\S]+?)~~/g },
    { type: "italic", regex: /(^|[^*])\*([^*\n]+)\*/g }
  ];

  let best = null;
  patterns.forEach((pattern) => {
    pattern.regex.lastIndex = start;
    const match = pattern.regex.exec(text);
    if (!match) return;
    const index = pattern.type === "italic" ? match.index + match[1].length : match.index;
    if (!best || index < best.index) {
      best = { ...pattern, match, index };
    }
  });
  return best;
}

function parseInline(text) {
  const nodes = [];
  let cursor = 0;
  const source = String(text || "");

  while (cursor < source.length) {
    const token = findNextInlineToken(source, cursor);
    if (!token) {
      nodes.push(textNode(source.slice(cursor)));
      break;
    }

    if (token.index > cursor) {
      nodes.push(textNode(source.slice(cursor, token.index)));
    }

    const match = token.match;
    if (token.type === "image") {
      const alt = match[1] || "";
      const src = match[2] || "";
      if (isSafeUrl(src)) {
        nodes.push(element("img", "max-width:100%;height:auto;border-radius:8rpx;margin:12rpx 0;", [], {
          src,
          alt
        }));
      } else {
        nodes.push(textNode(alt || src));
      }
      cursor = match.index + match[0].length;
    } else if (token.type === "link") {
      const label = match[1] || "";
      const href = match[2] || "";
      const safeAttrs = isSafeUrl(href) ? { href } : {};
      nodes.push(element("a", "color:#146c5c;text-decoration:underline;", parseInline(label), safeAttrs));
      cursor = match.index + match[0].length;
    } else if (token.type === "code") {
      nodes.push(element("code", "font-family:monospace;background:#f1eee8;border-radius:6rpx;padding:2rpx 8rpx;color:#2f2b26;", [rawTextNode(match[1])]));
      cursor = match.index + match[0].length;
    } else if (token.type === "math") {
      nodes.push(element("span", "font-family:serif;color:#2f2b26;", parseMathInline(match[1] || match[2] || match[3] || "")));
      cursor = match.index + match[0].length;
    } else if (token.type === "bold") {
      nodes.push(element("strong", "font-weight:700;", parseInline(match[1])));
      cursor = match.index + match[0].length;
    } else if (token.type === "strike") {
      nodes.push(element("del", "text-decoration:line-through;", parseInline(match[1])));
      cursor = match.index + match[0].length;
    } else {
      nodes.push(element("em", "font-style:italic;", parseInline(match[2])));
      cursor = match.index + match[0].length;
    }
  }

  return nodes.filter((node) => node.type !== "text" || node.text);
}

function isTableDelimiter(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseTable(lines, start) {
  const rows = [];
  let index = start;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    if (!isTableDelimiter(lines[index])) {
      rows.push(splitTableRow(lines[index]));
    }
    index += 1;
  }

  const children = rows.map((row, rowIndex) => element("tr", "", row.map((cell) => (
    element(rowIndex === 0 ? "th" : "td", "border:1px solid #ddd6ca;padding:8rpx 10rpx;text-align:left;vertical-align:top;", parseInline(cell))
  ))));
  return {
    node: element("table", "border-collapse:collapse;width:100%;margin:14rpx 0;font-size:28rpx;", children),
    next: index
  };
}

function mathBlockNode(content) {
  return element("p", "margin:12rpx 0 18rpx;line-height:1.78;font-family:serif;color:#2f2b26;", parseMathInline(content));
}

function parseMarkdownToNodes(markdown) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return [];

  const lines = source.split("\n");
  const nodes = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*\$\$\s*$/.test(line)) {
      const mathLines = [];
      index += 1;
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
        mathLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(mathBlockNode(mathLines.join(" ")));
      continue;
    }

    if (/^\s*\\\[/.test(line)) {
      const mathLines = [line.replace(/^\s*\\\[/, "")];
      index += 1;
      while (index < lines.length && !/\\\]\s*$/.test(mathLines[mathLines.length - 1])) {
        mathLines.push(lines[index]);
        index += 1;
      }
      if (mathLines.length) {
        mathLines[mathLines.length - 1] = mathLines[mathLines.length - 1].replace(/\\\]\s*$/, "");
      }
      nodes.push(mathBlockNode(mathLines.join(" ")));
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(element("pre", "box-sizing:border-box;overflow-x:auto;background:#2f2b26;color:#fff;border-radius:10rpx;padding:18rpx;margin:16rpx 0;font-size:26rpx;line-height:1.55;white-space:pre-wrap;", [
        element("code", "font-family:monospace;", [rawTextNode(codeLines.join("\n"))])
      ]));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const size = Math.max(30, 42 - (level - 1) * 3);
      nodes.push(element(`h${level}`, `font-size:${size}rpx;font-weight:700;line-height:1.35;margin:24rpx 0 12rpx;color:#211f1c;`, parseInline(heading[2])));
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      nodes.push(element("blockquote", "margin:16rpx 0;padding:8rpx 0 8rpx 20rpx;border-left:6rpx solid #d8d0c2;color:#5f574e;", parseInline(quoteLines.join("\n"))));
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!item || (/\d+\./.test(item[2]) !== ordered)) break;
        items.push(element("li", "margin:6rpx 0;", parseInline(item[3])));
        index += 1;
      }
      nodes.push(element(ordered ? "ol" : "ul", "margin:12rpx 0 12rpx 34rpx;padding:0;line-height:1.7;", items));
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1])) {
      const result = parseTable(lines, index);
      nodes.push(result.node);
      index = result.next;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    nodes.push(element("p", "margin:0 0 16rpx;line-height:1.78;", parseInline(paragraph.join("\n"))));
  }

  return nodes;
}

module.exports = {
  parseInline,
  parseMathInline,
  parseMarkdownToNodes
};
