type MainWindow = Readonly<{
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}>;
export function startMainWindow<T extends MainWindow>(
  options: Readonly<{ wasOpenedAtLogin: boolean; create(): T }>,
): T {
  const window = options.create();
  if (!options.wasOpenedAtLogin) window.show();
  return window;
}
export function activateMainWindow<T extends MainWindow>(current: T | undefined, create: () => T): T {
  const window = current && !current.isDestroyed() ? current : create();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}
