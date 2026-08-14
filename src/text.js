const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "div", "dl", "dt", "dd",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

const RAW_TEXT_TAGS = new Set(["script", "style", "template"]);

const tagEnd = (source, start) => {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
};

const tagInfo = (token) => {
  let index = 0;
  while (index < token.length && /\s/.test(token[index])) index += 1;
  const closing = token[index] === "/";
  if (closing) index += 1;
  while (index < token.length && /\s/.test(token[index])) index += 1;
  const start = index;
  while (index < token.length && /[a-z0-9:-]/i.test(token[index])) index += 1;
  return { closing, name: token.slice(start, index).toLowerCase() };
};

const RAW_TEXT_DELIMITERS = new Set([undefined, " ", "\t", "\n", "\f", "\r", "/"]);

const isRawTextClose = (token, expectedName) => {
  if (token[0] !== "/") return false;
  const candidate = token.slice(1, expectedName.length + 1).toLowerCase();
  return candidate === expectedName && RAW_TEXT_DELIMITERS.has(token[expectedName.length + 1]);
};

const NAMED_ENTITIES = new Map([
  ["&nbsp;", " "],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"]
]);

const decodeEntitiesOnce = (value) => String(value).replace(
  /&(?:nbsp|quot|apos|lt|gt|amp|#39|#x[0-9a-f]+|#[0-9]+);/gi,
  (entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === "&#39;") return "'";
    if (NAMED_ENTITIES.has(normalized)) return NAMED_ENTITIES.get(normalized);
    const hexadecimal = normalized.startsWith("&#x");
    const digits = normalized.slice(hexadecimal ? 3 : 2, -1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  }
);

export const htmlToPlainText = (value = "") => {
  const source = String(value);
  let output = "";
  let suppressedTag = null;

  for (let index = 0; index < source.length;) {
    if (source[index] !== "<") {
      if (!suppressedTag) output += source[index];
      index += 1;
      continue;
    }

    if (source.startsWith("<!--", index)) {
      const ordinaryEnd = source.indexOf("-->", index + 4);
      const bangEnd = source.indexOf("--!>", index + 4);
      const candidates = [ordinaryEnd, bangEnd].filter((position) => position >= 0);
      if (!candidates.length) break;
      const end = Math.min(...candidates);
      index = end + (end === bangEnd ? 4 : 3);
      continue;
    }

    const end = tagEnd(source, index);
    if (end < 0) {
      if (!suppressedTag) output += source.slice(index);
      break;
    }

    const token = source.slice(index + 1, end);
    const { closing, name } = tagInfo(token);
    if (suppressedTag) {
      if (isRawTextClose(token, suppressedTag)) suppressedTag = null;
    } else if (!closing && RAW_TEXT_TAGS.has(name)) {
      suppressedTag = name;
    } else if (BLOCK_TAGS.has(name)) {
      output += "\n";
    }
    index = end + 1;
  }

  return decodeEntitiesOnce(output)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
