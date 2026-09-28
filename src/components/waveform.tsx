import { useEffect, useRef, useState } from "react";

type Props = {
  peaks: Float32Array;
  duration: number;
  start: number;
  end: number;
  getTime: () => number;
  onChange: (start: number, end: number) => void;
  onSeek: (time: number) => void;
};

type DragKind = "start" | "end" | "move" | "seek";
type Drag = { kind: DragKind; x: number; start: number; end: number; time: number };

const INK = "#1c1a16";
const PAPER = "#f3efe6";
const AMBER = "#e4a04a";
const FAINT = "#6e675e";

export function Waveform({ peaks, duration, start, end, getTime, onChange, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const viewRef = useRef({ a: 0, b: Math.max(duration, 1) });
  const propsRef = useRef({ start, end, duration, onChange, onSeek, getTime });
  const lastTimeRef = useRef(0);
  const [view, setView] = useState({ a: 0, b: Math.max(duration, 1) });

  propsRef.current = { start, end, duration, onChange, onSeek, getTime };
  viewRef.current = view;

  useEffect(() => {
    setView((prev) => {
      if (prev.b <= 1 && duration > 1) return { a: 0, b: duration };
      return {
        a: Math.min(prev.a, duration),
        b: Math.min(Math.max(prev.b, prev.a + 0.5), duration || prev.b),
      };
    });
  }, [duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const parent = canvas.parentElement;
      if (!parent) return;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx || width < 2) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, width, height);

      const { a, b } = viewRef.current;
      const span = Math.max(0.001, b - a);
      const { start: s0, end: e0, duration: dur } = propsRef.current;
      const xOf = (t: number) => ((t - a) / span) * width;
      const playT = propsRef.current.getTime();
      if (Number.isFinite(playT)) {
        const moving = Math.abs(playT - lastTimeRef.current) > 0.015;
        lastTimeRef.current = playT;
        if (moving && (playT < a + span * 0.05 || playT > b - span * 0.05) && span < dur - 0.2) {
          let na = playT - span * 0.35;
          if (na < 0) na = 0;
          if (na + span > dur) na = Math.max(0, dur - span);
          if (Math.abs(na - a) > span * 0.04) setView({ a: na, b: Math.min(dur, na + span) });
        }
      }

      const selX = xOf(s0);
      const selW = Math.max(1, xOf(e0) - selX);
      ctx.fillStyle = "rgba(228,160,74,0.16)";
      ctx.fillRect(selX, 0, selW, height);

      const mid = height / 2;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const t = a + (x / width) * span;
        const idx = dur <= 0 ? 0 : Math.min(peaks.length - 1, Math.floor((t / dur) * peaks.length));
        const amp = peaks[idx] ?? 0;
        const y = Math.max(1, amp * (height * 0.42));
        ctx.moveTo(x + 0.5, mid - y);
        ctx.lineTo(x + 0.5, mid + y);
      }
      ctx.strokeStyle = FAINT;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.rect(selX, 0, selW, height);
      ctx.clip();
      ctx.beginPath();
      for (let x = Math.max(0, Math.floor(selX)); x < Math.min(width, Math.ceil(selX + selW)); x++) {
        const t = a + (x / width) * span;
        const idx = dur <= 0 ? 0 : Math.min(peaks.length - 1, Math.floor((t / dur) * peaks.length));
        const amp = peaks[idx] ?? 0;
        const y = Math.max(1, amp * (height * 0.42));
        ctx.moveTo(x + 0.5, mid - y);
        ctx.lineTo(x + 0.5, mid + y);
      }
      ctx.strokeStyle = AMBER;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = AMBER;
      ctx.fillRect(selX - 2, 0, 4, height);
      ctx.fillRect(selX + selW - 2, 0, 4, height);

      const play = xOf(propsRef.current.getTime());
      const midPlay = height / 2;
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(play, 0);
      ctx.lineTo(play, height);
      ctx.stroke();
      ctx.fillStyle = PAPER;
      ctx.beginPath();
      ctx.arc(play, midPlay, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = AMBER;
      ctx.beginPath();
      ctx.arc(play, midPlay, 3.5, 0, Math.PI * 2);
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [peaks]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      setView((prev) => {
        const span = Math.max(0.001, prev.b - prev.a);
        const nextSpan = Math.min(duration, Math.max(2, span * (event.deltaY > 0 ? 1.18 : 1 / 1.18)));
        const focus = prev.a + ratio * span;
        let a = focus - ratio * nextSpan;
        let b = a + nextSpan;
        if (a < 0) {
          b -= a;
          a = 0;
        }
        if (b > duration) {
          a -= b - duration;
          b = duration;
        }
        return { a: Math.max(0, a), b };
      });
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [duration]);

  function timeAt(clientX: number) {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const { a, b } = viewRef.current;
    return a + ratio * (b - a);
  }

  function hit(clientX: number, shift: boolean): DragKind {
    const wrap = wrapRef.current;
    if (!wrap) return "seek";
    const rect = wrap.getBoundingClientRect();
    const { a, b } = viewRef.current;
    const span = Math.max(0.001, b - a);
    const xOf = (t: number) => ((t - a) / span) * rect.width;
    const x = clientX - rect.left;
    const { start: s0, end: e0 } = propsRef.current;
    if (Math.abs(x - xOf(s0)) < 12) return "start";
    if (Math.abs(x - xOf(e0)) < 12) return "end";
    if (shift && x > xOf(s0) && x < xOf(e0)) return "move";
    return "seek";
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={wrapRef}
        className="relative h-24 w-full touch-none overflow-hidden rounded-md border border-line"
        onPointerDown={(event) => {
          const kind = hit(event.clientX, event.shiftKey) ?? "seek";
          const { start: s0, end: e0 } = propsRef.current;
          dragRef.current = { kind, x: event.clientX, start: s0, end: e0, time: timeAt(event.clientX) };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const wrap = wrapRef.current;
          if (!wrap) return;
          const rect = wrap.getBoundingClientRect();
          const { a, b } = viewRef.current;
          const span = Math.max(0.001, b - a);
          const dt = ((event.clientX - drag.x) / rect.width) * span;
          const dur = propsRef.current.duration;
          if (drag.kind === "start") {
            const next = Math.min(drag.start + dt, drag.end - 0.4);
            propsRef.current.onChange(Math.max(0, next), drag.end);
          } else if (drag.kind === "end") {
            const next = Math.max(drag.end + dt, drag.start + 0.4);
            propsRef.current.onChange(drag.start, Math.min(dur, next));
          } else if (drag.kind === "move") {
            const len = drag.end - drag.start;
            let s = drag.start + dt;
            let e = drag.end + dt;
            if (s < 0) {
              s = 0;
              e = len;
            }
            if (e > dur) {
              e = dur;
              s = dur - len;
            }
            propsRef.current.onChange(Math.max(0, s), Math.min(dur, e));
          } else {
            propsRef.current.onSeek(timeAt(event.clientX));
          }
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          if (drag.kind === "seek" && Math.abs(event.clientX - drag.x) < 4) {
            propsRef.current.onSeek(timeAt(event.clientX));
          }
        }}
        onDoubleClick={() => setView({ a: 0, b: duration || 1 })}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="h-11 rounded-md px-3 text-sm text-muted hover:bg-raised hover:text-fg"
          onClick={() => setView({ a: 0, b: duration || 1 })}
        >
          Весь трек
        </button>
        <button
          type="button"
          className="h-11 rounded-md px-3 text-sm text-muted hover:bg-raised hover:text-fg"
          onClick={() => {
            const pad = Math.max(0.35, (end - start) * 0.2);
            setView({
              a: Math.max(0, start - pad),
              b: Math.min(duration || end, end + pad),
            });
          }}
        >
          К отрывку
        </button>
        <p className="ml-auto self-center text-xs text-faint">Края — отрывок, по волне — ползунок, колесо — масштаб</p>
      </div>
    </div>
  );
}
