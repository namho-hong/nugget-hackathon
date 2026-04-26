import type { Logger } from "matrix-js-sdk/lib/logger.js";

type ConsoleMethod = (...args: unknown[]) => void;

export const silentMatrixLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  getChild: () => silentMatrixLogger,
};

export async function withSuppressedMatrixConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsole = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };

  const filtered = (method: ConsoleMethod): ConsoleMethod => {
    return (...args) => {
      if (isMatrixSdkConsoleLog(args)) {
        return;
      }

      method(...args);
    };
  };

  console.debug = filtered(originalConsole.debug);
  console.info = filtered(originalConsole.info);
  console.log = filtered(originalConsole.log);
  console.warn = filtered(originalConsole.warn);

  try {
    return await fn();
  } finally {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
}

function noop(): void {}

function isMatrixSdkConsoleLog(args: readonly unknown[]): boolean {
  const first = args[0];

  if (typeof first !== "string") {
    return false;
  }

  return (
    first.startsWith("FetchHttpApi:") ||
    first.startsWith("sync ") ||
    first.startsWith("stopping MatrixClient") ||
    first.startsWith("Attempting to send queued to-device messages") ||
    first.startsWith("All queued to-device messages sent") ||
    first.startsWith("Adding default global ") ||
    first.startsWith("[MatrixRTCSession ")
  );
}
