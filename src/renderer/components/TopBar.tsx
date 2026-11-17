import type { Area, ProjectView } from "../../shared/types";
import { GhostMark } from "./GhostMark";
import { Menu, type MenuItem } from "./Menu";

export type Place = "board" | "sessions" | "projects";

const PLACES: { id: Place; label: string; title: string }[] = [
  { id: "board", label: "Board", title: "Everything across all projects (⌘1)" },
  { id: "sessions", label: "Sessions", title: "Open and running Claude sessions (⌘2)" },
  { id: "projects", label: "Projects", title: "Every project: chats, runs, memory (⌘3)" },
];
const MARK_PX = 30;

interface Props {
  place: Place;
  needs: number;
  scope: ProjectView | null;
  projects: ProjectView[];
  areas: Area[];
  /** relative last activity per project id */
  lastActive: Record<string, string>;
  contextOpen: boolean;
  /** a session is shown on Sessions, so there is context to show */
  hasSession: boolean;
  onPlace: (place: Place) => void;
  onScope: (projectId: string | null) => void;
  onOpenPalette: () => void;
  onToggleContext: () => void;
}

/** The window's top bar: places on the left, the command field in the middle, scope and the mark on the right. */
export function TopBar({ place, needs, scope, projects, areas, lastActive, contextOpen, hasSession, onPlace, onScope, onOpenPalette, onToggleContext }: Props) {
  const scopeItems: MenuItem[] = [
    { label: "All projects", on: !scope, onClick: () => onScope(null) },
    ...areas.flatMap((a): MenuItem[] => {
      const inArea = projects.filter((p) => p.area === a.id);
      return inArea.length
        ? [{ heading: a.name }, ...inArea.map((p): MenuItem => ({ label: p.name, meta: lastActive[p.id], on: scope?.id === p.id, onClick: () => onScope(p.id) }))]
        : [];
    }),
  ];

  return (
    <header className="topbar">
      <div className="topbar-l">
        <span className="traffic-space" />
        <nav className="places">
          {PLACES.map((p) => (
            <button key={p.id} className={`no-drag ${place === p.id ? "on" : ""}`} title={p.title} onClick={() => onPlace(p.id)}>
              {p.label}
              {p.id === "board" && needs > 0 && <span className="n">{needs}</span>}
            </button>
          ))}
        </nav>
      </div>
      <button className="cmd-field no-drag" onClick={onOpenPalette}>
        <span>⌕</span>Go to, search, or run a command…<kbd>⌘K</kbd>
      </button>
      <div className="topbar-r">
        {place === "sessions" && hasSession && (
          <button className={`pill no-drag ${contextOpen ? "on" : ""}`} title="Project context (⌘.)" onClick={onToggleContext}>
            Context
          </button>
        )}
        <Menu
          trigger={(toggle) => (
            <button className={`scope-pill no-drag ${scope ? "set" : ""}`} onClick={toggle} title="Filter Board and ⌘K to one project">
              <span className="faint">Scope</span>
              <span className="ellipsis">{scope?.name ?? "All projects"}</span>▾
              {scope && (
                <span
                  className="x"
                  role="button"
                  title="Show all projects"
                  onClick={(e) => {
                    e.stopPropagation();
                    onScope(null);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          )}
          items={scopeItems}
        />
        <button className="mark-btn no-drag" title={needs ? `${needs} item${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} action` : "Nothing needs action"} onClick={() => onPlace("board")}>
          <GhostMark size={MARK_PX} revealed={needs > 0} title="" />
        </button>
      </div>
    </header>
  );
}
