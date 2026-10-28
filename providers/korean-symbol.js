// Six ASCII uppercase alphanumeric characters; never interpolate unvalidated
// external symbols into a URL or accept path separators, escapes or Unicode.
export function isKoreanSymbol(value) {
  return typeof value === "string" && value.length === 6 && /^[0-9A-Z]{6}$/.test(value);
}
