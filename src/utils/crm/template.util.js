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
 * Render a template by replacing {{variable}} placeholders.
 * Missing variables are replaced with an empty string.
 */
export const renderTemplate = (content, variables = {}) => {
  if (!content || typeof content !== "string") return "";
  VARIABLE_PATTERN.lastIndex = 0;
  return content.replace(VARIABLE_PATTERN, (match, name) => {
    const value =
      variables && Object.prototype.hasOwnProperty.call(variables, name)
        ? variables[name]
        : "";
    return value === null || value === undefined ? "" : String(value);
  });
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
