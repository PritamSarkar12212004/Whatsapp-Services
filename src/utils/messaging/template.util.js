/**
 * Template variable utilities.
 *
 * Templates use the {{variable}} placeholder syntax.
 *   content: "Hello {{name}}, your OTP is {{otp}}."
 *   variables: { name: "Pritam", otp: "482921" }
 *   rendered: "Hello Pritam, your OTP is 482921."
 */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all variable names found in a template string.
 * Returns an array of unique variable names (in order of first appearance).
 */
export const extractVariables = (content) => {
  if (!content || typeof content !== "string") return [];
  const seen = new Set();
  const variables = [];
  VARIABLE_PATTERN.lastIndex = 0;
  let match;
  while ((match = VARIABLE_PATTERN.exec(content)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      variables.push(name);
    }
  }
  return variables;
};

/**
 * Escape a string for use inside a RegExp.
 */
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Render a template by replacing {{variable}} placeholders AND bare
 * variable words (word-boundary), so users can write `otp` instead of
 * having to type `{{otp}}`. Missing variables are replaced with an empty
 * string.
 */
export const renderTemplate = (content, variables = {}) => {
  if (!content || typeof content !== "string") return "";
  let rendered = content;
  const vars = variables && typeof variables === "object" ? variables : {};

  // 1) Replace {{variable}} placeholders first
  rendered = rendered.replace(VARIABLE_PATTERN, (match, name) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : "";
    return value === null || value === undefined ? "" : String(value);
  });

  // 2) Also replace bare words (e.g. `otp`) with word boundaries — the
  //    frontend highlights these, and users often write them plainly.
  for (const [name, value] of Object.entries(vars)) {
    if (!name) continue;
    const val = value === null || value === undefined ? "" : String(value);
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    rendered = rendered.replace(re, val);
  }

  return rendered;
};

/**
 * Render a template media object's dynamic fields.
 * The url/caption may contain {{variable}} placeholders (dev mode dynamic
 * links) — each is replaced per recipient. Returns null when no media.
 */
export const renderTemplateMedia = (media, variables = {}) => {
  if (!media || !media.url) return null;
  return {
    url: renderTemplate(media.url, variables),
    filename: media.filename ? renderTemplate(media.filename, variables) : null,
    mimeType: media.mimeType || null,
    caption: media.caption ? renderTemplate(media.caption, variables) : null,
  };
};

/**
 * Extract the first http(s) URL from a piece of text (or null).
 */
export const extractUrlFromText = (text) => {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
};

/**
 * Convenience: extract variables from content + merge with provided defaults.
 */
export const normalizeVariables = (content, variables = {}) => {
  const detected = extractVariables(content);
  const merged = { ...variables };
  detected.forEach((v) => {
    if (!Object.prototype.hasOwnProperty.call(merged, v)) {
      merged[v] = "";
    }
  });
  return { variables: detected, merged };
};
