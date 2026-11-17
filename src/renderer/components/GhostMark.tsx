import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

/* GhostOS's mark, ported from the design system (components/brand/GhostMark.jsx).
   One continuous stroke, drawn like a ribbon. At rest it lies flat like a sheet on the floor;
   when revealed, its middle lifts into a ghost while the ends stay on the floor as the hem. */

const VIEW_W = 120;
const VIEW_H = 100;
const FLOOR_Y = 86;
const GHOST: [number, number][] = [[6, 86], [19, 85.5], [29, 81], [34, 64], [36.5, 40], [46, 21], [60, 15], [74, 21], [83.5, 40], [86, 64], [91, 81], [101, 85.5], [114, 86]];
const N = GHOST.length;
const FLAT: [number, number][] = GHOST.map((_, i) => [6 + i * (108 / (N - 1)), FLOOR_Y]);
const EYES: [number, number][] = [[53, 42], [67, 42]];
/** how much each point follows the bob and lean (the dome) */
const DOME = [0, 0, 0, 0.35, 0.7, 0.95, 1, 0.95, 0.7, 0.35, 0, 0, 0];
/** which points ripple along the floor (the hem) */
const HEM = [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
const EYE_RY = 4.6;
const SPRING = 170;
const DAMPING = 15;
const MAX_FRAME_S = 0.033;

const f = (n: number) => n.toFixed(2);

function toPath(p: [number, number][]): string {
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Shape at reveal progress p (0 = flat sheet, 1 = ghost), time t in seconds, lean in -1..1. */
function ghostFrame(p: number, t = 0, lean = 0, alive = true): { d: string; bob: number } {
  const bob = alive ? Math.sin(t * 2) * 1.3 * p : 0;
  const pts = GHOST.map((g, i): [number, number] => {
    const fl = FLAT[i];
    const x = fl[0] + (g[0] - fl[0]) * p + lean * 6 * DOME[i] * p;
    let y = fl[1] + (g[1] - fl[1]) * p;
    if (alive) {
      y += DOME[i] * bob;
      y += HEM[i] * Math.sin(t * 3.1 + i * 1.7) * 1.4 * Math.min(p, 1);
      y += Math.sin(t * 2.2 - i * 0.75) * 0.5 * Math.max(0, 1 - p * 1.6) * (i > 0 && i < N - 1 ? 1 : 0);
    }
    return [x, y];
  });
  return { d: toPath(pts), bob };
}

interface Props {
  size?: number;
  /** true = ghost, false = flat sheet; undefined = reveals on hover */
  revealed?: boolean;
  color?: string;
  weight?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function GhostMark({ size = 68, revealed, color = "var(--accent-bright)", weight = 5.5, title = "GhostOS", className, style }: Props) {
  const [hover, setHover] = useState(false);
  const target = revealed === undefined ? hover : revealed;
  const goal = useRef(target ? 1 : 0);
  goal.current = target ? 1 : 0;
  const svg = useRef<SVGSVGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const eyes = [useRef<SVGEllipseElement>(null), useRef<SVGEllipseElement>(null)];
  const st = useRef({ p: goal.current, v: 0, lean: 0, leanT: 0, blinkAt: 2.5, last: 0 });

  const paint = (p: number, t: number, alive: boolean) => {
    const s = st.current;
    const frame = ghostFrame(Math.max(0, p), t, s.lean, alive);
    path.current?.setAttribute("d", frame.d);
    const open = Math.max(0, Math.min(1, (p - 0.55) / 0.35));
    let blink = 1;
    if (alive && t > s.blinkAt) {
      const k = (t - s.blinkAt) / 0.16;
      blink = k < 1 ? Math.abs(1 - 2 * k) : 1;
      if (k >= 1) s.blinkAt = t + 2.8 + Math.random() * 3;
    }
    eyes.forEach((r, i) => {
      if (!r.current) return;
      r.current.setAttribute("cx", f(EYES[i][0] + s.lean * 4.5 * p));
      r.current.setAttribute("cy", f(EYES[i][1] + frame.bob));
      r.current.setAttribute("ry", f(EYE_RY * open * blink + 0.001));
      r.current.setAttribute("opacity", open > 0 ? "1" : "0");
    });
    if (svg.current) {
      const glow = Math.min(p, 1);
      svg.current.style.filter = p > 0.02 ? `drop-shadow(0 0 ${f(7 * glow)}px rgba(45,190,137,${f(0.38 * glow)}))` : "none";
    }
  };

  useEffect(() => {
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const s = st.current;
      const t = (now - t0) / 1000;
      const dt = Math.min(MAX_FRAME_S, Math.max(0.001, t - s.last));
      s.last = t;
      if (reduce) s.p = goal.current;
      else {
        s.v += (SPRING * (goal.current - s.p) - DAMPING * s.v) * dt;
        s.p += s.v * dt;
      }
      s.lean += ((goal.current ? s.leanT : 0) - s.lean) * Math.min(1, dt * 6);
      paint(s.p, t, !reduce);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // paint reads refs only, so one loop serves the component's lifetime
  }, []);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    st.current.leanT = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
  };

  return (
    <svg
      ref={svg}
      className={className}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={size}
      height={(size * VIEW_H) / VIEW_W}
      role="img"
      aria-label={title}
      style={{ display: "block", overflow: "visible", ...style }}
      onMouseEnter={revealed === undefined ? () => setHover(true) : undefined}
      onMouseLeave={revealed === undefined ? () => setHover(false) : undefined}
      onMouseMove={onMove}
    >
      <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="transparent" />
      <path ref={path} d={ghostFrame(goal.current, 0, 0, false).d} fill="none" stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" />
      {EYES.map((c, i) => (
        <ellipse key={i} ref={eyes[i]} cx={c[0]} cy={c[1]} rx={Math.max(3.2, weight * 0.62)} ry={goal.current ? EYE_RY : 0.001} fill={color} opacity={goal.current ? 1 : 0} />
      ))}
    </svg>
  );
}
