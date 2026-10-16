import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import "./toast.css";
export type CanvasToastMessage = Readonly<{
  message: string;
  undo?: () => void | Promise<void>;
  disabled?: boolean;
  action?: Readonly<{ label: string; run: () => void }>;
}>;
type ToastState = {
  show: (message: CanvasToastMessage) => void;
  update: (message: CanvasToastMessage) => void;
  close: () => void;
  dismiss: (message: string) => void;
};
const Context = createContext<ToastState | null>(null);
export function CanvasToastProvider(props: Readonly<{ children: ReactNode }>): ReactElement {
  const [message, setMessage] = useState<CanvasToastMessage | null>(null);
  const [sequence, setSequence] = useState(0);
  const show = useCallback((next: CanvasToastMessage): void => {
    setMessage(next);
    setSequence((value) => value + 1);
  }, []);
  const close = useCallback((): void => setMessage(null), []);
  const dismiss = useCallback((text: string): void => {
    setMessage((current) => (current?.message === text ? null : current));
  }, []);
  return (
    <Context.Provider
      value={{
        show,
        // A background sheet may only update the result it showed.
        update: (next) => setMessage((current) => (current?.message === next.message ? next : current)),
        close,
        dismiss,
      }}
    >
      {props.children}
      {message ? <CanvasToast key={sequence} {...message} onClose={close} /> : null}
    </Context.Provider>
  );
}
export function useCanvasToast(): ToastState {
  const context = useContext(Context);
  if (!context) throw new Error("Canvas toasts require the canvas toast provider.");
  return context;
}
export function useOptionalCanvasToast(): ToastState | null {
  return useContext(Context);
}
export function CanvasToast(props: CanvasToastMessage & Readonly<{ onClose: () => void }>): ReactElement | null {
  const { t } = useI18n();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bar = useRef<HTMLSpanElement>(null);
  const [paused, setPaused] = useState(false);
  function arm(duration: number): void {
    clearTimeout(timer.current);
    timer.current = setTimeout(props.onClose, duration);
  }
  useEffect(() => {
    arm(6000);
    return () => clearTimeout(timer.current);
  }, []);
  const canvas = document.querySelector<HTMLElement>(".resource-canvas");
  if (!canvas) return null;
  return createPortal(
    <div
      className="toast canvas-toast"
      role="status"
      onMouseEnter={() => {
        clearTimeout(timer.current);
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
        arm(2500);
        const progress = bar.current;
        if (progress) {
          const remaining = getComputedStyle(progress).transform;
          progress.style.setProperty(
            "--canvas-toast-from",
            remaining && remaining !== "none" ? remaining : "scaleX(1)",
          );
          progress.style.animation = "none";
          void progress.offsetWidth;
          progress.style.animation = "canvas-toast-resume 2.5s linear forwards";
        }
      }}
    >
      <span>{props.message}</span>
      {props.action ? (
        <button
          type="button"
          onClick={() => {
            props.action?.run();
            props.onClose();
          }}
        >
          {props.action.label}
        </button>
      ) : null}
      {props.undo ? (
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => {
            void props.undo?.();
            props.onClose();
          }}
        >
          {t("projectView.undo")}
        </button>
      ) : null}
      <button className="canvas-toast-close" aria-label={t("canvas.close")} type="button" onClick={props.onClose}>
        ×
      </button>
      <span
        ref={bar}
        className="canvas-toast-bar"
        aria-hidden="true"
        style={{ animationPlayState: paused ? "paused" : "running" }}
      />
    </div>,
    canvas,
  );
}
