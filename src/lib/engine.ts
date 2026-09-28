import { DEFAULT_LOOK, type Aspect, type Look } from "@/lib/project";

export const FRAME: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

const ANIM_MS = 480;
const RECORD_FPS = 30;
const FONT = "700 {size}px Manrope, ui-sans-serif, sans-serif";

export type Script = {
  lines: string[];
  cues: (number | null)[];
  start: number;
  end: number;
  aspect: Aspect;
  followCues: boolean;
  look: Look;
};

export type EngineSnap = {
  playing: boolean;
  recording: boolean;
  line: number;
};

type StopHandler = (blob: Blob, ext: string) => void;

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const list = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return list.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? "";
}

export function extOf(type: string) {
  return type.includes("mp4") ? "mp4" : "webm";
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length < 6) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(from: string, to: string, t: number) {
  const u = clamp01(t);
  const [ar, ag, ab] = hexToRgb(from);
  const [br, bg, bb] = hexToRgb(to);
  const r = Math.round(ar + (br - ar) * u);
  const g = Math.round(ag + (bg - ag) * u);
  const b = Math.round(ab + (bb - ab) * u);
  return `rgb(${r} ${g} ${b})`;
}

function snapSize(size: number) {
  return Math.max(16, Math.round(size / 2) * 2);
}

function fontAt(size: number) {
  return FONT.replace("{size}", String(Math.round(size)));
}

type Fitted = { size: number; rows: string[]; lh: number; block: number };

function focusSize(aspect: Aspect, w: number) {
  if (aspect === "9:16") return Math.round(w * 0.074);
  if (aspect === "1:1") return Math.round(w * 0.058);
  return Math.round(w * 0.048);
}

/** 720p-class frame. A CPU encoder keeps a steady 30fps here; 1080p drops frames without a GPU. */
function recordFrame(aspect: Aspect): { w: number; h: number } {
  if (aspect === "9:16") return { w: 720, h: 1280 };
  if (aspect === "1:1") return { w: 720, h: 720 };
  return { w: 1280, h: 720 };
}

function docY(doc: Map<number, number>, center: number, last: number) {
  const c = Math.max(-1, Math.min(last, center));
  const lo = Math.floor(c);
  const hi = Math.ceil(c);
  const t = c - lo;
  const a = doc.get(lo) ?? 0;
  const b = doc.get(hi) ?? a;
  return a + (b - a) * t;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (ctx.measureText(trial).width <= maxWidth) {
      current = trial;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

export class PerformanceEngine {
  canvas: HTMLCanvasElement | null = null;
  buffer: AudioBuffer | null = null;
  script: Script = {
    lines: [],
    cues: [],
    start: 0,
    end: 0,
    aspect: "16:9",
    followCues: false,
    look: { ...DEFAULT_LOOK },
  };

  line = -1;
  playing = false;
  recording = false;
  scrub = 0;

  onSnap: ((snap: EngineSnap) => void) | null = null;
  onCues: ((cues: (number | null)[]) => void) | null = null;
  onStop: StopHandler | null = null;
  onTick: ((songTime: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private playGen = 0;
  private finishPromise: Promise<void> | null = null;
  private originCtxTime = 0;
  private originSongTime = 0;
  private animFrom = -1;
  private animTo = -1;
  private animStart = 0;
  private settled = new Set<number>();
  private previewRaf = 0;
  private raf = 0;
  private mime = "";
  private fontKick = false;
  private playUntil = 0;
  private fitCache = new Map<string, Fitted>();
  private recordSize: { w: number; h: number } | null = null;
  private recordTrack: CanvasCaptureMediaStreamTrack | null = null;
  private recordTimer = 0;
  private nextFrameAt = 0;
  private uiAt = 0;

  unlock() {
    const ctx = this.ensureCtx();
    void ctx.resume();
  }

  snap(): EngineSnap {
    return { playing: this.playing, recording: this.recording, line: this.line };
  }

  time() {
    if (this.playing && this.ctx) {
      return this.originSongTime + (this.ctx.currentTime - this.originCtxTime);
    }
    return this.scrub;
  }

  duration() {
    return this.buffer?.duration ?? 0;
  }

  seek(songTime: number) {
    if (this.recording) return;
    const dur = this.duration();
    const next = Math.min(Math.max(0, songTime), dur > 0 ? dur : Math.max(0, songTime));
    this.scrub = next;
    if (this.playing && this.ctx && this.buffer) {
      if (next > this.playUntil - 0.08) this.playUntil = this.buffer.duration;
      this.startSource(Math.min(next, Math.max(0, this.buffer.duration - 0.05)), this.playGen);
      if (this.script.followCues) this.jumpLine(this.lineAt(next));
      this.emit();
      return;
    }
    if (this.script.followCues) this.jumpLine(this.lineAt(this.scrub));
    this.draw();
    this.emit();
  }

  advance(stamp: boolean) {
    const last = this.script.lines.length - 1;
    if (last < 0 || this.line >= last) return;
    const next = this.line + 1;
    if (stamp && this.buffer) {
      const cues = this.script.cues.slice();
      while (cues.length <= next) cues.push(null);
      cues[next] = Math.max(0, this.time());
      this.script = { ...this.script, cues };
      this.onCues?.(cues);
    }
    this.setLine(next);
  }

  retreat() {
    if (this.line < 0) return;
    const cues = this.script.cues.slice();
    for (let i = this.line; i < cues.length; i++) cues[i] = null;
    this.script = { ...this.script, cues };
    this.onCues?.(cues);
    this.setLine(this.line - 1);
  }

  jumpLine(n: number) {
    this.line = n;
    this.animFrom = n;
    this.animTo = n;
    this.animStart = 0;
    this.draw();
    this.emit();
  }

  async play(record: boolean) {
    const wasPlaying = this.playing;
    const resumeFrom = wasPlaying ? this.time() : this.scrub;
    await this.stop();
    if (!this.buffer || !this.canvas) {
      this.onError?.("Сначала добавьте песню.");
      return;
    }
    if (!this.script.lines.length) {
      this.onError?.("Добавьте текст — одна строка, одна смена кадра.");
      return;
    }
    const span = this.script.end - this.script.start;
    if (span < 0.35) {
      this.onError?.("Отрывок слишком короткий. Раздвиньте края на волне.");
      return;
    }

    try {
      await document.fonts.load("700 96px Manrope");
    } catch {
      /* fallback font still draws */
    }

    const ctx = this.ensureCtx();
    await ctx.resume();
    const dur = this.buffer.duration;
    const offset = record
      ? Math.min(Math.max(0, this.script.start), Math.max(0, dur - 0.05))
      : Math.min(Math.max(0, resumeFrom), Math.max(0, dur - 0.05));
    this.playUntil = record ? this.script.end : offset < this.script.end - 0.05 ? this.script.end : dur;
    const playFor = Math.min(dur - offset, Math.max(0, this.playUntil - offset));
    if (playFor < 0.05) {
      this.onError?.("Ползунок стоит в самом конце трека.");
      return;
    }
    this.recordSize = record ? recordFrame(this.script.aspect) : null;
    this.jumpLine(this.script.followCues ? this.lineAt(offset) : -1);
    this.draw();
    if (record) this.warmFits();

    const gen = ++this.playGen;
    this.chunks = [];
    this.mime = "";

    if (record) {
      if (typeof MediaRecorder === "undefined" || !this.canvas.captureStream) {
        this.recordSize = null;
        this.draw();
        this.onError?.("Этот браузер не умеет писать видео. Подойдёт Chrome или Edge.");
        return;
      }
      const canvasStream = this.canvas.captureStream(0);
      const track = canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
      if (!track) {
        this.recordSize = null;
        this.draw();
        this.onError?.("Не удалось снять кадр.");
        return;
      }
      this.recordTrack = track;
      const audioTracks = this.recordDest?.stream.getAudioTracks() ?? [];
      if (!audioTracks.length) {
        this.recordSize = null;
        this.recordTrack = null;
        this.draw();
        this.onError?.("Не удалось захватить звук.");
        return;
      }
      const mixed = new MediaStream([track, ...audioTracks]);
      this.mime = pickMime();
      this.recorder = this.makeRecorder(mixed);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      this.recorder.start();
      this.recording = true;
    }

    this.startSource(offset, gen);
    this.playing = true;
    this.emit();
    if (record) this.recordPump();
    else this.tick();
  }

  stop(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    const rec = this.recorder;
    const live = Boolean(this.playing || (rec && rec.state !== "inactive"));
    if (!live) return Promise.resolve();
    const gen = this.playGen;
    this.playGen += 1;
    this.finishPromise = this.finish(gen).finally(() => {
      this.finishPromise = null;
    });
    return this.finishPromise;
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    this.kickFonts();
    const { w, h } = this.recordSize ?? FRAME[this.script.aspect];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const look = { ...DEFAULT_LOOK, ...(this.script.look ?? {}) };

    ctx.clearRect(0, 0, w, h);
    this.paintBackdrop(ctx, w, h, look);

    const lines = this.script.lines;
    const scale = Math.min(1.8, Math.max(0.5, look.fontScale || 1));
    const focus = Math.round(focusSize(this.script.aspect, w) * scale);
    const dim = Math.round(focus * 0.72);
    const before = Math.min(8, Math.max(0, Math.round(look.linesBefore ?? 3)));
    const after = Math.min(8, Math.max(0, Math.round(look.linesAfter ?? 2)));
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animMs = reduce ? 0 : ANIM_MS;
    const raw = this.animStart === 0 || animMs === 0 ? 1 : Math.min(1, (performance.now() - this.animStart) / animMs);
    const eased = easeOut(raw);
    const center = this.animFrom + (this.animTo - this.animFrom) * eased;

    if (lines.length) {
      const maxWidth = w * 0.86;
      const gap = focus * 0.5;
      const order = [-1, ...lines.map((_, index) => index)];
      const fitted = new Map<number, Fitted>();
      for (const index of order) {
        if (index < 0) {
          fitted.set(index, { size: focus, rows: [], lh: focus, block: focus * 0.92 });
          continue;
        }
        const distance = Math.abs(index - center);
        const size0 = snapSize(dim + (focus - dim) * clamp01(1 - Math.min(distance, 1.15) / 1.15));
        fitted.set(index, this.fitBlock(ctx, lines[index] ?? "", maxWidth, size0));
      }
      const doc = new Map<number, number>();
      let cursor = 0;
      for (const index of order) {
        const block = fitted.get(index)!.block;
        doc.set(index, cursor + block / 2);
        cursor += block + gap;
      }
      const focusDoc = docY(doc, center, lines.length - 1);
      const anchor = h * 0.5;
      const topLimit = look.corner.trim() ? h * 0.145 : h * 0.03;
      for (let index = 0; index < lines.length; index++) {
        const fittedLine = fitted.get(index)!;
        const y = anchor + (doc.get(index)! - focusDoc);
        if (y + fittedLine.block < -8 || y - fittedLine.block > h + 8) continue;
        const behind = center - index;
        const ahead = index - center;
        const fadeBand = 0.4;
        if (behind > before + fadeBand || ahead > after + fadeBand) continue;
        let windowFade = 1;
        if (behind > before) windowFade = clamp01(1 - (behind - before) / fadeBand);
        else if (ahead > after) windowFade = clamp01(1 - (ahead - after) / fadeBand);
        const distance = Math.abs(index - center);
        const emphasis = clamp01(1 - distance * 2.15);
        const color = mixHex(look.dim, look.ink, emphasis);
        const edge = clamp01(Math.min(y - topLimit, h * 0.97 - y) / (h * 0.09));
        const alpha = clamp01(edge * windowFade);
        if (alpha < 0.04) continue;
        this.paintFitted(ctx, fittedLine, w / 2, y, color, look.stroke, look.strokePx, alpha);
      }
    }

    this.paintCorner(ctx, w, h, look);
  }

  private paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, look: Look) {
    const top = look.bg || DEFAULT_LOOK.bg;
    const bottom = look.bg2 || top;
    if (bottom.toLowerCase() !== top.toLowerCase()) {
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, top);
      gradient.addColorStop(1, bottom);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = top;
    }
    ctx.fillRect(0, 0, w, h);
    if (!look.vignette) return;
    const glow = ctx.createRadialGradient(
      w / 2,
      h * 0.48,
      Math.min(w, h) * 0.2,
      w / 2,
      h * 0.5,
      Math.max(w, h) * 0.68,
    );
    glow.addColorStop(0, "rgba(0,0,0,0)");
    glow.addColorStop(1, "rgba(0,0,0,0.48)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }

  private warmFits() {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const { w } = this.recordSize ?? FRAME[this.script.aspect];
    const look = { ...DEFAULT_LOOK, ...(this.script.look ?? {}) };
    const focus = snapSize(focusSize(this.script.aspect, w) * Math.min(1.8, Math.max(0.5, look.fontScale || 1)));
    const dim = snapSize(focus * 0.72);
    const maxWidth = w * 0.86;
    for (const line of this.script.lines) {
      for (let size = dim; size <= focus; size += 2) this.fitBlock(ctx, line, maxWidth, size);
    }
  }

  private fitBlock(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size0: number): Fitted {
    const asked = snapSize(size0);
    const key = `${asked}|${Math.round(maxWidth)}|${text}`;
    const cached = this.fitCache.get(key);
    if (cached) return cached;
    let size = Math.max(18, asked);
    const floor = Math.max(16, snapSize(size0 * 0.62));
    let rows = [text];
    while (size > floor) {
      ctx.font = fontAt(size);
      rows = wrapLines(ctx, text, maxWidth);
      const tooWide = rows.some((row) => ctx.measureText(row).width > maxWidth + 1);
      if (!tooWide && rows.length <= 3) break;
      size -= 2;
    }
    ctx.font = fontAt(size);
    rows = wrapLines(ctx, text, maxWidth).slice(0, 3);
    const lh = size * 1.12;
    const fitted = { size, rows, lh, block: Math.max(lh, rows.length * lh) };
    if (this.fitCache.size > 600) this.fitCache.clear();
    this.fitCache.set(key, fitted);
    return fitted;
  }

  private paintFitted(
    ctx: CanvasRenderingContext2D,
    fitted: Fitted,
    x: number,
    centerY: number,
    fill: string,
    strokeColor: string,
    strokePx: number,
    alpha: number,
  ) {
    const stroke = strokePx <= 0 ? 0 : (strokePx / 10) * fitted.size * 0.16;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = fontAt(fitted.size);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let y = centerY - fitted.block / 2 + fitted.lh / 2;
    for (const row of fitted.rows) {
      this.ink(ctx, row, x, y, fill, strokeColor, stroke);
      y += fitted.lh;
    }
    ctx.restore();
  }

  private paintCorner(ctx: CanvasRenderingContext2D, w: number, h: number, look: Look) {
    const text = look.corner.trim();
    if (!text) return;
    const size = Math.max(28, Math.round(Math.min(w, h) * 0.046));
    ctx.save();
    ctx.font = fontAt(size);
    const rows = wrapLines(ctx, text, w * 0.52).slice(0, 3);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const stroke = look.strokePx <= 0 ? 0 : (look.strokePx / 10) * size * 0.16;
    const x = w * 0.05;
    let y = h * 0.048;
    for (const row of rows) {
      this.ink(ctx, row, x, y, look.ink, look.stroke, stroke);
      y += size * 1.2;
    }
    ctx.restore();
  }

  private ink(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    fill: string,
    stroke: string,
    width: number,
  ) {
    if (width > 0.35) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private kickFonts() {
    if (this.fontKick || typeof document === "undefined") return;
    this.fontKick = true;
    void document.fonts.load("700 96px Manrope").then(() => {
      this.fitCache.clear();
      this.draw();
    });
  }

  private lineAt(songTime: number) {
    let line = -1;
    const count = this.script.lines.length;
    for (let i = 0; i < count; i++) {
      const cue = this.script.cues[i];
      if (cue != null && songTime + 0.001 >= cue) line = i;
    }
    return line;
  }

  private setLine(n: number) {
    if (n === this.line) return;
    this.animFrom = this.line;
    this.animTo = n;
    this.animStart = performance.now();
    this.line = n;
    this.emit();
    if (this.playing) this.draw();
    else this.animateIdle();
  }

  private animateIdle() {
    cancelAnimationFrame(this.previewRaf);
    const loop = () => {
      this.draw();
      const reduce =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce && !this.playing && this.animStart > 0 && performance.now() - this.animStart < ANIM_MS) {
        this.previewRaf = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  private tick = () => {
    if (!this.playing) return;
    const t = this.time();
    if (this.script.followCues) {
      const next = this.lineAt(t);
      if (next !== this.line) this.setLine(next);
    }
    this.draw();
    this.onTick?.(t);
    if (t >= this.playUntil - 0.02) {
      void this.stop();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private recordPump = () => {
    this.raf = requestAnimationFrame((now) => {
      if (!this.playing || !this.recording) return;
      if (now + 1 < this.nextFrameAt) {
        this.recordPump();
        return;
      }
      this.nextFrameAt = now + 1000 / RECORD_FPS;
      const t = this.time();
      if (this.script.followCues) {
        const next = this.lineAt(t);
        if (next !== this.line) this.setLine(next);
      }
      this.draw();
      try {
        this.recordTrack?.requestFrame();
      } catch {
        /* track already ended */
      }
      if (now - this.uiAt > 100) {
        this.uiAt = now;
        this.onTick?.(t);
      }
      if (t >= this.playUntil - 0.02) {
        void this.stop();
        return;
      }
      this.recordPump();
    });
  };

  private startSource(offset: number, gen: number) {
    const ctx = this.ctx;
    const buffer = this.buffer;
    if (!ctx || !buffer) return;
    const prev = this.source;
    if (prev) {
      prev.onended = null;
      try {
        prev.stop();
      } catch {
        /* already stopped */
      }
      prev.disconnect();
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master!);
    this.source = source;
    source.onended = () => {
      if (gen !== this.playGen || this.source !== source) return;
      void this.stop();
    };
    const until = Math.min(buffer.duration, Math.max(offset + 0.05, this.playUntil));
    const playFor = Math.max(0.05, Math.min(buffer.duration - offset, until - offset));
    const when = ctx.currentTime + 0.04;
    this.originSongTime = offset;
    this.originCtxTime = when;
    this.scrub = offset;
    source.start(when, Math.min(offset, Math.max(0, buffer.duration - 0.05)), playFor);
  }

  private ensureCtx() {
    if (!this.ctx || this.ctx.state === "closed") {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const recordDest = ctx.createMediaStreamDestination();
      master.connect(recordDest);
      this.ctx = ctx;
      this.master = master;
      this.recordDest = recordDest;
    }
    return this.ctx;
  }

  private makeRecorder(stream: MediaStream) {
    const { w, h } = this.recordSize ?? FRAME[this.script.aspect];
    const bits = Math.round(Math.min(4_000_000, Math.max(1_800_000, w * h * 3)));
    const opts: MediaRecorderOptions = {
      videoBitsPerSecond: bits,
      audioBitsPerSecond: 128_000,
    };
    if (this.mime) opts.mimeType = this.mime;
    try {
      return new MediaRecorder(stream, opts);
    } catch {
      try {
        return new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
      } catch {
        return new MediaRecorder(stream);
      }
    }
  }

  private async finish(gen: number) {
    if (this.settled.has(gen)) return;
    this.settled.add(gen);
    if (this.settled.size > 24) {
      this.settled.clear();
      this.settled.add(gen);
    }

    const live = this.ctx ? this.originSongTime + (this.ctx.currentTime - this.originCtxTime) : this.scrub;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.previewRaf);
    window.clearTimeout(this.recordTimer);
    this.recordTimer = 0;
    this.nextFrameAt = 0;
    this.recordTrack = null;
    try {
      this.source?.stop();
    } catch {
      /* already ended */
    }
    this.source?.disconnect();
    this.source = null;

    let blob: Blob | null = null;
    const rec = this.recorder;
    if (rec && rec.state !== "inactive") {
      blob = await new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          const type = rec.mimeType || this.mime || "video/webm";
          resolve(new Blob(this.chunks, { type }));
        };
        rec.stop();
      });
    }
    this.recorder = null;
    this.recording = false;
    this.recordSize = null;
    this.chunks = [];
    const dur = this.duration();
    this.scrub = dur ? Math.min(Math.max(live, 0), dur) : Math.max(live, 0);
    this.draw();
    this.emit();
    if (blob) this.onStop?.(blob, extOf(blob.type || this.mime));
  }

  private emit() {
    this.onSnap?.(this.snap());
  }
}
