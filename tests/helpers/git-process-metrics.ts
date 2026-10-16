import { promisify } from "node:util";
import { vi } from "vitest";

// Preserve execFile's promisified child handle while counting actual Git launches.
export function instrumentGitProcesses(
  module: typeof import("node:child_process"),
  launched: (args: readonly string[]) => void,
  queried?: (expression: string) => void,
): typeof module {
  const original = module.execFile;
  const wrapped = vi.fn((...args: Parameters<typeof original>) => {
    if (args[0] === "git") launched(args[1] as string[]);
    return original(...args);
  });
  const custom = (original as unknown as Record<symbol, (...args: unknown[]) => unknown>)[promisify.custom]!;
  Object.defineProperty(wrapped, promisify.custom, {
    value: (...args: unknown[]) => {
      if (args[0] === "git") launched(args[1] as string[]);
      return custom(...args);
    },
  });
  return {
    ...module,
    execFile: wrapped as unknown as typeof original,
    spawn: vi.fn((...args: Parameters<typeof module.spawn>) => {
      if (args[0] === "git") launched(args[1] as string[]);
      const child = module.spawn(...args);
      if (args[0] === "git" && args[1]?.includes("cat-file") && child.stdin && queried) {
        const write = child.stdin.write.bind(child.stdin);
        vi.spyOn(child.stdin, "write").mockImplementation((...input: Parameters<typeof write>) => {
          queried(String(input[0]).trim());
          return write(...input);
        });
      }
      return child;
    }) as unknown as typeof module.spawn,
  };
}
