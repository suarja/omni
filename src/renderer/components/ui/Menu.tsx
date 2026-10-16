import { useEffect, useRef, type ReactElement } from "react";

export type MenuItem = Readonly<{ label: string; onSelect: () => void }>;

export function Menu({ items, onClose }: Readonly<{ items: readonly MenuItem[]; onClose: () => void }>): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const handlePointerDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [onClose]);
  return (
    <div className="ui-menu" ref={menuRef} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          role="menuitem"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
