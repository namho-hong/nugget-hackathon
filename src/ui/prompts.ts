import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

export interface PromptIo {
  input: ReadStream;
  output: WriteStream;
}

export type PromptResult =
  | { type: "value"; value: string }
  | { type: "home" }
  | { type: "quit" };

export async function promptRequired(
  label: string,
  io: PromptIo = { input: process.stdin, output: process.stdout },
): Promise<string> {
  if (!io.input.isTTY || !io.output.isTTY) {
    throw new Error(
      `Cannot prompt for ${label} in a non-interactive terminal. Pass it as an argument.`,
    );
  }

  const readline = createInterface({
    input: io.input,
    output: io.output,
  });

  let canceled = false;
  const onSigint = (): void => {
    canceled = true;
    readline.close();
  };

  readline.on("SIGINT", onSigint);

  try {
    while (true) {
      let answer: string;

      try {
        answer = (await readline.question(`${label}: `)).trim();
      } catch (error) {
        if (canceled) {
          throw new Error("Canceled.");
        }

        throw error;
      }

      if (answer.length > 0) {
        return answer;
      }

      io.output.write(`${label} is required.\n`);
    }
  } finally {
    readline.off("SIGINT", onSigint);
    readline.close();
  }
}

export async function promptRequiredNavigation(
  label: string,
  io: PromptIo = { input: process.stdin, output: process.stdout },
): Promise<PromptResult> {
  if (!io.input.isTTY || !io.output.isTTY) {
    throw new Error(
      `Cannot prompt for ${label} in a non-interactive terminal. Pass it as an argument.`,
    );
  }

  const readline = createInterface({
    input: io.input,
    output: io.output,
  });

  let canceled = false;
  const onSigint = (): void => {
    canceled = true;
    readline.close();
  };

  readline.on("SIGINT", onSigint);

  try {
    while (true) {
      let answer: string;

      try {
        answer = (await readline.question(`${label} (/home, /quit): `)).trim();
      } catch (error) {
        if (canceled) {
          return { type: "quit" };
        }

        throw error;
      }

      if (answer === "/home") {
        return { type: "home" };
      }

      if (answer === "/quit" || answer === "/exit") {
        return { type: "quit" };
      }

      if (answer.length > 0) {
        return { type: "value", value: answer };
      }

      io.output.write(`${label} is required.\n`);
    }
  } finally {
    readline.off("SIGINT", onSigint);
    readline.close();
  }
}
