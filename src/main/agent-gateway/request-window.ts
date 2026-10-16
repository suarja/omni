type RequestWindow = Readonly<{
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    isLoading(): boolean;
    once(event: "did-finish-load", listener: () => void): unknown;
  };
}>;

export function showAgentRequestWindow<T extends RequestWindow>(
  existing: T | undefined,
  create: () => T,
  open: (window: T) => void,
): T {
  const reusable = existing && !existing.isDestroyed() ? existing : undefined;
  const window = reusable ?? create();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const send = (): void => {
    if (!window.isDestroyed()) open(window);
  };
  if (!reusable || window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
  return window;
}
