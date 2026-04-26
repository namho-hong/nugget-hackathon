import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

export interface PromptIo {
  input: ReadStream;
  output: WriteStream;
}

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
