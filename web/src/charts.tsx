// Hand-built SVG charts for the v4 page (no chart library): donut, half gauge,
// progress ring and mini bars. Each draws in once on load (CSS transitions,
// which reduced motion turns off) and follows its value after that.
import { useEffect, useId, useState, type ReactNode } from 'react';

/** False on the first frame, then true, so a transition can run from "empty". */
export function useMounted(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(f);
  }, []);
  return on;
}

export type Segment = { key: string; label: string; value: number; color: string };

/** A donut with an optional centre. Segments draw in clockwise from the top. */
export function Donut({ segments, size = 148, thickness = 18, center, label }: { segments: Segment[]; size?: number; thickness?: number; center?: ReactNode; label: string }) {
  const mounted = useMounted();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + s.value, 0);
  const gap = segments.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-track)" strokeWidth={thickness} />
        {total > 0 &&
          segments.map((s) => {
            const len = (s.value / total) * c;
            const shown = Math.max(0, len - gap);
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={mounted ? `${shown} ${c - shown}` : `0 ${c}`}
                strokeDashoffset={-offset}
                style={{ transition: 'stroke-dasharray 0.9s cubic-bezier(0.3,0.7,0.2,1), stroke-dashoffset 0.9s' }}
              >
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  );
}

/**
 * A half-circle gauge from 0 to 100 with an accent-to-teal arc and a dark
 * needle that sweeps to the value (and to any new value later).
 */
export function HalfGauge({ pct, width = 200, label, children }: { pct: number; width?: number; label: string; children?: ReactNode }) {
  const mounted = useMounted();
  const id = useId().replace(/:/g, '');
  const stroke = Math.round(width * 0.09);
  const r = width / 2 - stroke / 2 - 2;
  const cx = width / 2;
  const cy = width / 2;
  const h = width / 2 + 8;
  const v = Math.max(0, Math.min(100, pct));
  const shown = mounted ? v : 0;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return (
    <div className="relative" style={{ width, height: h }}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-label={label}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--color-accent)" />
            <stop offset="1" stopColor="var(--color-accent-2)" />
          </linearGradient>
        </defs>
        <path d={arc} fill="none" stroke="var(--color-track)" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={arc}
          fill="none"
          stroke={`url(#g${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${shown} 100`}
          style={{ transition: 'stroke-dasharray 1.1s cubic-bezier(0.3,0.7,0.2,1)', opacity: v === 0 ? 0 : 1 }}
        />
        <g style={{ transform: `rotate(${-90 + shown * 1.8}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: 'transform 1.2s cubic-bezier(0.34,1.4,0.5,1)' }}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - r + stroke * 0.9} stroke="var(--color-ink)" strokeWidth={3} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={6} fill="var(--color-ink)" />
        <circle cx={cx} cy={cy} r={2.5} fill="var(--color-card)" />
      </svg>
      {children}
    </div>
  );
}

/** A small progress ring (0–100). */
export function Ring({ pct, size = 44, thickness = 6, color = 'var(--color-accent)', label }: { pct: number; size?: number; thickness?: number; color?: string; label: string }) {
  const mounted = useMounted();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const len = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-track)" strokeWidth={thickness} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={`${mounted ? len : 0} ${c}`}
        style={{ transition: 'stroke-dasharray 1.1s cubic-bezier(0.3,0.7,0.2,1)', opacity: pct <= 0 ? 0 : 1 }}
      />
    </svg>
  );
}

/** Small vertical bars, one per value, each in its own colour. */
export function MiniBars({ bars, height = 40, label }: { bars: { key: string; value: number; color: string; title: string }[]; height?: number; label: string }) {
  const mounted = useMounted();
  const max = Math.max(1, ...bars.map((b) => b.value));
  const w = 7;
  const gap = 4;
  const width = Math.max(w, bars.length * (w + gap) - gap);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="shrink-0">
      {bars.length === 0 && <rect x={0} y={height - 3} width={w} height={3} rx={1.5} fill="var(--color-track)" />}
      {bars.map((b, i) => {
        const h = Math.max(3, (b.value / max) * height);
        return (
          <rect
            key={b.key}
            x={i * (w + gap)}
            width={w}
            rx={2}
            y={mounted ? height - h : height - 3}
            height={mounted ? h : 3}
            fill={b.value ? b.color : 'var(--color-track)'}
            style={{ transition: `y 0.8s ${i * 0.06}s cubic-bezier(0.3,0.7,0.2,1), height 0.8s ${i * 0.06}s cubic-bezier(0.3,0.7,0.2,1)` }}
          >
            <title>{b.title}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** A colour swatch for legends; a small square so it isn't confused with a status dot. */
export const Swatch = ({ color, hollow }: { color: string; hollow?: boolean }) => (
  <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={hollow ? { border: `1.5px dashed ${color}` } : { background: color }} />
);
