import {
  fitDisplayText,
  getDisplayWidth,
  sanitizeForTerminal,
  truncateDisplayText,
} from "../util/terminal.js";

const ANSI_RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const INVERSE = "\x1b[7m";

export interface RenderPickerLineOptions {
  label: string;
  selected: boolean;
  disabled?: boolean | undefined;
  width: number;
  tag?: string | undefined;
  useAnsi?: boolean | undefined;
}

export function renderPickerHeader(
  title: string,
  subtitle: string,
  width: number,
  useAnsi: boolean,
): string[] {
  const cleanWidth = Math.max(20, width);
  const titleLine = fitDisplayText(sanitizeForTerminal(title).toUpperCase(), cleanWidth);
  const divider = "-".repeat(cleanWidth);

  return [
    style(titleLine, BOLD, useAnsi),
    subtitle.length > 0 ? style(fitDisplayText(subtitle, cleanWidth), DIM, useAnsi) : "",
    style(divider, DIM, useAnsi),
  ];
}

export function renderPickerSectionTitle(title: string, width: number, useAnsi: boolean): string {
  const line = fitDisplayText(title, Math.max(20, width));
  return style(line, BOLD, useAnsi);
}

export function renderPickerLine(options: RenderPickerLineOptions): string {
  const width = Math.max(20, options.width);
  const prefix = options.selected ? "> " : "  ";
  const tag = options.tag ? `[${sanitizeForTerminal(options.tag)}] ` : "";
  const labelWidth = Math.max(1, width - getDisplayWidth(prefix) - getDisplayWidth(tag));
  const label = truncateDisplayText(options.label, labelWidth);
  const line = fitDisplayText(`${prefix}${tag}${label}`, width);

  if (options.selected) {
    return style(line, INVERSE, options.useAnsi ?? false);
  }

  if (options.disabled) {
    return style(line, DIM, options.useAnsi ?? false);
  }

  return line;
}

export function renderPickerNotice(notice: string, width: number, useAnsi: boolean): string {
  return style(fitDisplayText(notice, Math.max(20, width)), DIM, useAnsi);
}

export function renderPickerFooter(text: string, width: number, useAnsi: boolean): string {
  return style(fitDisplayText(text, Math.max(20, width)), DIM, useAnsi);
}

function style(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI_RESET}` : value;
}
