type QuitEvent = Readonly<{ preventDefault(): void }>;
type Cleanup = Readonly<{ name: string; run(): void | Promise<void> }>;
export type AppShutdown = Readonly<{
  addCleanup(name: string, run: Cleanup["run"]): void;
  prepareForUpdate(): Promise<void>;
  isQuitting(): boolean;
}>;

/** Owns cleanup, not Squirrel's termination. Once prepared, native quit must not be cancelled. */
export function createAppShutdown(
  options: Readonly<{
    app: { on(event: "before-quit", listener: (event: QuitEvent) => void): unknown; exit(code: number): void };
    killChildren(): void;
    report(message: string, error: unknown): void;
  }>,
): AppShutdown {
  const cleanups: Cleanup[] = [];
  let quitting = false;
  let prepared = false;
  let preparation: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    quitting = true;
    return (preparation ??= new Promise<void>((resolve) => {
      const pending = new Set(cleanups.map(({ name }) => name));
      const finish = (): void => {
        clearTimeout(deadline);
        options.killChildren();
        prepared = true;
        resolve();
      };
      const deadline = setTimeout(() => {
        options.report(
          `Omni quit cleanup exceeded 3000ms: ${[...pending].join(", ")}. Terminating owned children.`,
          new Error("Shutdown deadline"),
        );
        finish();
      }, 3000);
      void Promise.allSettled(
        cleanups.map(async ({ name, run }) => {
          try {
            await run();
          } catch (error) {
            options.report(`Omni quit cleanup failed: ${name}.`, error);
          } finally {
            pending.delete(name);
          }
        }),
      ).then(() => {
        if (!prepared) finish();
      });
    }));
  };
  options.app.on("before-quit", (event) => {
    if (prepared) return;
    event.preventDefault();
    // app.exit bypasses renderer beforeunload vetoes for an explicit application Quit.
    if (!quitting) void prepare().then(() => options.app.exit(0));
  });
  return {
    addCleanup: (name, run) => {
      if (quitting) throw new Error(`Cannot register ${name}: Omni is quitting.`);
      cleanups.push({ name, run });
    },
    prepareForUpdate: prepare,
    isQuitting: () => quitting,
  };
}
