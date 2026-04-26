export function sanitizeForTerminal(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join(" ");
}

export function fitDisplayText(value: string, width: number): string {
  const cleanWidth = Math.max(0, width);
  const text = truncateDisplayText(sanitizeForTerminal(value), cleanWidth);
  return `${text}${" ".repeat(Math.max(0, cleanWidth - getDisplayWidth(text)))}`;
}

export function truncateDisplayText(value: string, width: number): string {
  const cleanWidth = Math.max(0, width);
  const text = sanitizeForTerminal(value);

  if (getDisplayWidth(text) <= cleanWidth) {
    return text;
  }

  if (cleanWidth <= 0) {
    return "";
  }

  if (cleanWidth <= 3) {
    return truncateWithoutMarker(text, cleanWidth);
  }

  let result = "";
  let resultWidth = 0;
  const marker = "...";
  const targetWidth = cleanWidth - marker.length;

  for (const char of Array.from(text)) {
    const charWidth = getCharDisplayWidth(char);

    if (resultWidth + charWidth > targetWidth) {
      break;
    }

    result += char;
    resultWidth += charWidth;
  }

  return `${result}${marker}`;
}

function truncateWithoutMarker(value: string, width: number): string {
  let result = "";
  let resultWidth = 0;

  for (const char of Array.from(value)) {
    const charWidth = getCharDisplayWidth(char);

    if (resultWidth + charWidth > width) {
      break;
    }

    result += char;
    resultWidth += charWidth;
  }

  return result;
}

export function getDisplayWidth(value: string): number {
  let width = 0;

  for (const char of Array.from(value)) {
    width += getCharDisplayWidth(char);
  }

  return width;
}

function getCharDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }

  return 1;
}
