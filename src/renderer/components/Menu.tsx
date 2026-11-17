import { useEffect, useRef, useState, type ReactNode } from "react";

/** One menu entry: an action, a section heading, a caption, or "-" for a separator. */
export type MenuItem =
  | "-"
  | { heading: string }
  | { caption: string; title?: string }
  | { label: string; kbd?: string; /** faint text on the right, e.g. a time */ meta?: string; danger?: boolean; disabled?: boolean; title?: string; on?: boolean; onClick: () => void };

interface Props {
  /** renders the button that opens the menu; call `toggle` from its onClick */
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  items: MenuItem[];
  /** which edge of the trigger the menu lines up with */
  align?: "left" | "right";
  /** opens above the trigger (for menus at the bottom of the window) */
  up?: boolean;
}

/** An anchored popover menu. Closes on an outside click, on Escape, and after an item is chosen. */
export function Menu({ trigger, items, align = "right", up = false }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const position = { [align]: 0, [up ? "bottom" : "top"]: "calc(100% + 4px)" };
  return (
    <span ref={ref} className="menu-anchor" onClick={(e) => e.stopPropagation()}>
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <div className="menu" role="menu" style={position}>
          {items.map((item, i) => {
            if (item === "-") return <hr key={i} />;
            if ("heading" in item) return <div key={i} className="menu-label">{item.heading}</div>;
            if ("caption" in item) return <div key={i} className="menu-caption" title={item.title}>{item.caption}</div>;
            return (
              <button
                key={i}
                role="menuitem"
                className={`${item.danger ? "danger" : ""} ${item.on ? "on" : ""}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
                {item.kbd && <kbd>{item.kbd}</kbd>}
                {item.meta && <span className="m">{item.meta}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
