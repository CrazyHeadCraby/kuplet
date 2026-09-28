import { useCallback, useEffect, useRef, useState } from "react";
import { Waveform } from "@/components/waveform";
import { DEMO_AUDIO, DEMO_CUES, DEMO_LYRICS, computePeaks, decodeAudio, synthDemo } from "@/lib/audio";
import { cn } from "@/lib/cn";
import { PerformanceEngine, type EngineSnap } from "@/lib/engine";
import { countWords, parseLrc, parseLyrics, remapCues, wordsPhrase } from "@/lib/lyrics";
import {
  DEFAULT_LOOK,
  blankProject,
  deleteProject,
  listProjects,
  loadAudio,
  normalizeProject,
  saveAudio,
  saveProject,
  type Aspect,
  type Look,
  type ProjectMeta,
} from "@/lib/project";
import { fileSlug, formatTime, parseTime } from "@/lib/time";

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

const PRESETS: { name: string; look: Pick<Look, "bg" | "bg2" | "ink" | "dim" | "stroke" | "strokePx" | "vignette"> }[] = [
  {
    name: "Пример",
    look: { bg: "#333333", bg2: "#333333", ink: "#f2f2f2", dim: "#8a8a8a", stroke: "#111111", strokePx: 0, vignette: false },
  },
  {
    name: "Ночь",
    look: { bg: "#121212", bg2: "#2c261c", ink: "#f6f1e7", dim: "#9a9086", stroke: "#000000", strokePx: 0, vignette: true },
  },
  {
    name: "Бумага",
    look: { bg: "#f4efe6", bg2: "#e3d9c8", ink: "#1c1915", dim: "#7a7268", stroke: "#1c1915", strokePx: 0, vignette: false },
  },
  {
    name: "Обводка",
    look: { bg: "#161616", bg2: "#161616", ink: "#ffffff", dim: "#c4c4c4", stroke: "#000000", strokePx: 7, vignette: false },
  },
];

const field = "h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none";
const ghost = "h-11 rounded-md px-3 text-sm text-muted hover:bg-raised hover:text-fg";
const lineBtn = "h-11 rounded-md border border-line px-3 text-sm hover:bg-raised";
const solid = "h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink";

function lookOf(project: ProjectMeta): Look {
  return {
    bg: project.bg,
    bg2: project.bg2,
    ink: project.ink,
    dim: project.dim,
    stroke: project.stroke,
    strokePx: project.strokePx,
    corner: project.corner,
    vignette: project.vignette,
    fontScale: project.fontScale,
    linesBefore: project.linesBefore,
    linesAfter: project.linesAfter,
  };
}

function stageClass(aspect: Aspect) {
  if (aspect === "9:16") return "stage-tall";
  if (aspect === "1:1") return "stage-square";
  return "stage-wide";
}

function frameClass(aspect: Aspect) {
  if (aspect === "9:16") return "frame-tall";
  if (aspect === "1:1") return "frame-square";
  return "frame-wide";
}

export function KupletApp() {
  const engineRef = useRef<PerformanceEngine | null>(null);
  if (!engineRef.current) engineRef.current = new PerformanceEngine();
  const engine = engineRef.current;

  const [view, setView] = useState<"library" | "studio">("library");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [duration, setDuration] = useState(0);
  const [snap, setSnap] = useState<EngineSnap>({ playing: false, recording: false, line: -1 });
  const [clock, setClock] = useState(0);
  const [error, setError] = useState("");
  const [video, setVideo] = useState<{ url: string; name: string } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);

  const projectRef = useRef(project);
  const viewRef = useRef(view);
  const bootId = useRef<string | null>(null);
  const countRef = useRef(-1);
  const armGen = useRef(0);
  const audioInput = useRef<HTMLInputElement>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  projectRef.current = project;
  viewRef.current = view;

  const patch = useCallback((partial: Partial<ProjectMeta>) => {
    setProject((prev) => (prev ? { ...prev, ...partial } : prev));
  }, []);

  useEffect(() => {
    const eng = engineRef.current!;
    let tickAt = 0;
    eng.onSnap = () => {
      setSnap(eng.snap());
      setClock(eng.time());
    };
    eng.onTick = (time) => {
      const now = performance.now();
      if (now - tickAt < 32) return;
      tickAt = now;
      setClock(time);
    };
    eng.onCues = (cues) => setProject((prev) => (prev ? { ...prev, cues } : prev));
    eng.onError = (message) => setError(message);
    eng.onStop = (blob, ext) => {
      const title = projectRef.current?.title || "kuplet";
      setVideo((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), name: `${fileSlug(title)}.${ext}` };
      });
    };
    const onVis = () => {
      if (document.hidden && eng.recording) {
        setError("Вкладка скрыта — запись может встать. Держите её открытой.");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void eng.stop();
    };
  }, []);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => setError("Не удалось открыть библиотеку в этом браузере."));
  }, []);

  useEffect(() => {
    if (!project) return;
    const handle = window.setTimeout(() => {
      const next = { ...project, updatedAt: Date.now() };
      void saveProject(next);
      setProjects((rows) => {
        const copy = rows.filter((row) => row.id !== next.id);
        return [next, ...copy].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [project]);

  useEffect(() => {
    if (!project) return;
    const lines = parseLyrics(project.lyricsText);
    const end = project.end > project.start ? project.end : duration || project.start + 1;
    const fresh = bootId.current !== project.id;
    if (fresh) {
      bootId.current = project.id;
      countRef.current = -1;
    }
    const prevCount = countRef.current;
    countRef.current = lines.length;
    engine.script = {
      lines,
      cues: project.cues.slice(),
      start: Math.max(0, project.start),
      end,
      aspect: project.aspect,
      followCues: project.followCues,
      look: lookOf(project),
    };
    if (engine.playing) {
      engine.draw();
      return;
    }
    if (!lines.length) {
      engine.jumpLine(-1);
      return;
    }
    if (fresh || prevCount <= 0) {
      const preferred =
        project.titleLine != null && project.titleLine < lines.length ? project.titleLine : Math.min(1, lines.length - 1);
      engine.jumpLine(preferred);
      return;
    }
    if (engine.line >= lines.length) engine.jumpLine(lines.length - 1);
    else engine.draw();
  }, [project, duration, engine]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (viewRef.current !== "studio") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const current = projectRef.current;
      if (!current) return;
      if (event.code === "Space") {
        event.preventDefault();
        engine.advance(engine.playing);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        engine.advance(engine.playing);
      } else if (event.code === "ArrowLeft" || event.code === "Backspace") {
        event.preventDefault();
        engine.retreat();
      } else if (event.code === "Escape") {
        armGen.current += 1;
        setCountdown(0);
        void engine.stop();
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.code === "KeyI" || event.code === "KeyO")) {
        const time = Math.max(0, engine.time());
        if (event.code === "KeyI") {
          const end = current.end > time ? current.end : time + 8;
          setProject((prev) => (prev ? { ...prev, start: time, end } : prev));
        } else {
          setProject((prev) => (prev ? { ...prev, end: Math.max(time, prev.start + 0.4) } : prev));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  useEffect(() => () => {
    if (video) URL.revokeObjectURL(video.url);
  }, [video]);

  async function openProject(meta: ProjectMeta) {
    const next = normalizeProject(meta);
    setError("");
    setVideo(null);
    setView("studio");
    setBusy(true);
    try {
      if (next.audioName === DEMO_AUDIO) {
        const buffer = await synthDemo();
        engine.buffer = buffer;
        setPeaks(computePeaks(buffer));
        setDuration(buffer.duration);
      } else {
        const blob = await loadAudio(next.id);
        if (!blob) {
          engine.buffer = null;
          setPeaks(null);
          setDuration(0);
        } else {
          const buffer = await decodeAudio(blob);
          engine.buffer = buffer;
          setPeaks(computePeaks(buffer));
          setDuration(buffer.duration);
        }
      }
      engine.seek(next.start);
      setProject(next);
    } catch {
      setError("Не удалось открыть вопрос.");
      setProject(next);
    } finally {
      setBusy(false);
    }
  }

  function createBlank() {
    const meta = blankProject();
    engine.buffer = null;
    setPeaks(null);
    setDuration(0);
    setVideo(null);
    setError("");
    setProject(meta);
    setView("studio");
  }

  async function makeDemo() {
    setBusy(true);
    setError("");
    try {
      const buffer = await synthDemo();
      const meta = normalizeProject({
        ...DEFAULT_LOOK,
        title: "На мосту",
        lyricsText: DEMO_LYRICS,
        cues: [...DEMO_CUES],
        titleLine: 1,
        start: 0,
        end: 12,
        aspect: "16:9",
        followCues: false,
        audioName: DEMO_AUDIO,
        corner: "2 слова",
      });
      engine.buffer = buffer;
      setPeaks(computePeaks(buffer));
      setDuration(buffer.duration);
      setVideo(null);
      setProject(meta);
      setView("studio");
    } catch {
      setError("Демо не собралось.");
    } finally {
      setBusy(false);
    }
  }

  async function onAudioFile(file: File) {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      const buffer = await decodeAudio(file);
      engine.buffer = buffer;
      setPeaks(computePeaks(buffer));
      setDuration(buffer.duration);
      await saveAudio(project.id, file);
      setProject((prev) => {
        if (!prev) return prev;
        const start = Math.min(prev.start, Math.max(0, buffer.duration - 0.5));
        const end = prev.end > start && prev.end <= buffer.duration + 0.05 ? prev.end : buffer.duration;
        return { ...prev, audioName: file.name, start, end };
      });
    } catch {
      setError("Не получилось прочитать аудио. Подойдёт mp3, wav, m4a или ogg.");
    } finally {
      setBusy(false);
    }
  }

  function onLyricsText(text: string) {
    setProject((prev) => {
      if (!prev) return prev;
      const prevLines = parseLyrics(prev.lyricsText);
      const nextLines = parseLyrics(text);
      const titled = prev.titleLine != null ? prevLines[prev.titleLine] : undefined;
      const titleLine = titled ? nextLines.indexOf(titled) : -1;
      return {
        ...prev,
        lyricsText: text,
        cues: remapCues(prevLines, nextLines, prev.cues),
        titleLine: titleLine >= 0 ? titleLine : null,
      };
    });
  }

  async function onLyricsFile(file: File) {
    const text = await file.text();
    const lrc = parseLrc(text);
    if (!lrc) {
      onLyricsText(text);
      return;
    }
    const start = Math.max(0, (lrc.times[0] ?? 0) - 0.3);
    const end = (lrc.times[lrc.times.length - 1] ?? start) + 1.8;
    setProject((prev) =>
      prev
        ? {
            ...prev,
            lyricsText: lrc.lines.join("\n"),
            cues: lrc.times,
            followCues: true,
            start,
            end,
            titleLine: prev.titleLine != null && prev.titleLine < lrc.lines.length ? prev.titleLine : null,
          }
        : prev,
    );
  }

  async function onJsonFile(file: File) {
    try {
      const meta = normalizeProject({ ...(JSON.parse(await file.text()) as ProjectMeta), id: crypto.randomUUID() });
      meta.audioName = "";
      setProjects((rows) => [meta, ...rows.filter((row) => row.id !== meta.id)]);
      await openProject(meta);
      setError("Текст и вид загружены. Песню выберите заново — аудио в файл не входит.");
    } catch {
      setError("Этот файл не похож на вопрос Куплета.");
    }
  }

  function putWords(source: string) {
    const count = countWords(source);
    if (!count) {
      setError("Сначала впишите слова, из которых считать.");
      return;
    }
    setError("");
    patch({ corner: wordsPhrase(count) });
  }

  function cancelArm() {
    armGen.current += 1;
    setCountdown(0);
  }

  async function listen() {
    cancelArm();
    engine.unlock();
    setError("");
    await engine.play(false);
  }

  async function arm() {
    engine.unlock();
    if (!engine.buffer) {
      setError("Сначала добавьте песню.");
      return;
    }
    if (!project || !parseLyrics(project.lyricsText).length) {
      setError("Добавьте текст — одна строка, одна смена.");
      return;
    }
    const span = (project.end > project.start ? project.end : duration) - project.start;
    if (span < 0.35) {
      setError("Отрывок слишком короткий. Раздвиньте края на волне.");
      return;
    }
    const gen = ++armGen.current;
    for (const step of [3, 2, 1]) {
      if (armGen.current !== gen) return;
      setCountdown(step);
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    }
    if (armGen.current !== gen) return;
    setCountdown(0);
    await engine.play(true);
  }

  async function removeProject(id: string) {
    await deleteProject(id);
    setProjects((rows) => rows.filter((row) => row.id !== id));
    if (project?.id === id) {
      setProject(null);
      setView("library");
      engine.buffer = null;
    }
  }

  const lines = project ? parseLyrics(project.lyricsText) : [];
  const titleWords = project ? countWords(project.title) : 0;
  const marked = project?.titleLine != null ? lines[project.titleLine] : "";

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 py-5 pb-16">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-display text-4xl leading-none text-fg">Куплет</p>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Отрывок песни и строки, которые пролистываются: в центре текущая, выше прошлые, ниже следующие.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={ghost} onClick={() => setView("library")}>
            Библиотека
          </button>
          <button type="button" className={lineBtn} onClick={() => void makeDemo()} disabled={busy}>
            Демо
          </button>
          <button type="button" className={solid} onClick={createBlank}>
            Новый вопрос
          </button>
        </div>
      </header>

      {error ? (
        <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg" role="status">
          {error}
          <button type="button" className="ml-3 text-muted underline" onClick={() => setError("")}>
            Скрыть
          </button>
        </p>
      ) : null}

      {view === "library" || !project ? (
        <Library
          projects={projects}
          busy={busy}
          onOpen={(item) => void openProject(item)}
          onDelete={(id) => void removeProject(id)}
          onImport={() => jsonInput.current?.click()}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
          <section className="grid gap-4">
            <div className={stageClass(project.aspect)}>
              <div className={cn("relative overflow-hidden rounded-lg border border-line bg-black", frameClass(project.aspect))}>
                <canvas
                  ref={(node) => {
                    engine.canvas = node;
                    if (node) engine.draw();
                  }}
                  className="h-full w-full"
                />
                {countdown > 0 ? (
                  <div className="absolute inset-0 grid place-items-center bg-black/55 font-display text-7xl text-fg" aria-live="polite">
                    {countdown}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={solid} onClick={() => void listen()} disabled={busy}>
                {snap.playing && !snap.recording ? "Ещё раз" : "Слушать"}
              </button>
              <button
                type="button"
                className={ghost}
                onClick={() => {
                  cancelArm();
                  void engine.stop();
                }}
              >
                Стоп
              </button>
              {countdown > 0 ? (
                <button type="button" className={lineBtn} onClick={cancelArm}>
                  Отмена {countdown}
                </button>
              ) : (
                <button type="button" className={cn(lineBtn, snap.recording && "border-transparent bg-[#b5403a] text-white")} onClick={() => void arm()} disabled={busy}>
                  {snap.recording ? "Идёт запись" : "Запись"}
                </button>
              )}
              <button type="button" className={ghost} onClick={() => engine.advance(engine.playing)}>
                Дальше
              </button>
              <button type="button" className={lineBtn} onClick={() => patch({ followCues: !project.followCues })}>
                {project.followCues ? "По меткам" : "Пробелом"}
              </button>
              <p className="ml-auto font-mono text-sm text-muted">
                {formatTime(clock, true)}
                <span className="text-faint"> / {formatTime(duration)}</span>
                {snap.recording ? <span className="rec-dot ml-2 inline-block h-2 w-2 rounded-full bg-[#b5403a]" /> : null}
              </p>
            </div>
            <p className="text-xs text-faint">
              Строка {snap.line < 0 ? "ещё не началась" : `${snap.line + 1} из ${lines.length}`}. Пробел — следующая. Ползунок под волной — откуда слушать. Жёлтые края — кусок записи.
            </p>

            <div className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button type="button" className={lineBtn} onClick={() => audioInput.current?.click()} disabled={busy}>
                  {project.audioName && project.audioName !== DEMO_AUDIO ? "Другая песня" : "Песня"}
                </button>
                <span className="truncate text-sm text-muted">{project.audioName === DEMO_AUDIO ? "Демо-тон" : project.audioName || "файл не выбран"}</span>
              </div>
              {peaks && duration > 0 ? (
                <Waveform
                  peaks={peaks}
                  duration={duration}
                  start={project.start}
                  end={project.end > project.start ? project.end : duration}
                  getTime={() => engine.time()}
                  onSeek={(time) => {
                    engine.seek(time);
                    setClock(engine.time());
                  }}
                  onChange={(start, end) => patch({ start, end })}
                />
              ) : (
                <p className="text-sm text-muted">Загрузите песню — на волне можно выбрать кусок, где звучит название.</p>
              )}
              {duration > 0 ? (
                <label className="mt-3 grid gap-1 text-xs text-muted">
                  Позиция: {formatTime(clock, true)}
                  <input
                    type="range"
                    aria-label="Позиция трека"
                    min={0}
                    max={duration}
                    step={0.01}
                    value={Math.min(duration, Math.max(0, Number.isFinite(clock) ? clock : 0))}
                    onChange={(event) => {
                      const time = Number(event.target.value);
                      engine.seek(time);
                      setClock(engine.time());
                    }}
                  />
                </label>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <TimeField
                  label="Вход"
                  value={project.start}
                  onCommit={(start) => {
                    const next = Math.max(0, start);
                    patch({ start: next, end: project.end > next ? project.end : next + 8 });
                  }}
                />
                <TimeField label="Выход" value={project.end} onCommit={(end) => patch({ end: Math.max(project.start + 0.4, end) })} />
              </div>
            </div>

            {video ? (
              <div className="rounded-lg border border-line bg-surface p-3">
                <video src={video.url} controls className="mb-3 max-h-64 w-full rounded-md bg-black" />
                <a href={video.url} download={video.name} className={cn(solid, "inline-flex items-center")}>
                  Скачать {video.name}
                </a>
              </div>
            ) : null}
          </section>

          <section className="grid gap-4">
            <div className="grid gap-2 rounded-lg border border-line bg-surface p-3">
              <label className="grid gap-1 text-xs text-muted">
                Название песни
                <input className={field} value={project.title} onChange={(event) => patch({ title: event.target.value })} />
              </label>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">{titleWords ? wordsPhrase(titleWords) : "пока нет слов"}</span>
                <button type="button" className={ghost} onClick={() => putWords(project.title)}>
                  В угол
                </button>
                {marked ? (
                  <button type="button" className={ghost} onClick={() => putWords(marked)}>
                    Из строки со звездой
                  </button>
                ) : null}
              </div>
              <label className="grid gap-1 text-xs text-muted">
                Текст в левом верхнем углу кадра
                <input
                  className={field}
                  value={project.corner}
                  placeholder="3 слова"
                  maxLength={120}
                  onChange={(event) => patch({ corner: event.target.value })}
                />
              </label>
              <p className="text-xs text-faint">Попадёт в ролик. Обычно здесь пишут, сколько слов в названии.</p>
            </div>

            <div className="grid gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm">Текст</p>
                <button type="button" className={ghost} onClick={() => lyricsInput.current?.click()}>
                  Файл .txt / .lrc
                </button>
              </div>
              <textarea
                className="min-h-36 w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm leading-relaxed outline-none"
                value={project.lyricsText}
                placeholder={"Одна строка — одна смена кадра\nДлинная сама перенесётся"}
                onChange={(event) => onLyricsText(event.target.value)}
              />
              <ul className="grid max-h-72 gap-1 overflow-auto">
                {lines.map((line, index) => {
                  const cue = project.cues[index];
                  const active = snap.line === index;
                  return (
                    <li key={`${index}-${line}`} id={`line-${index}`} className={cn("flex items-center gap-1 rounded-md px-1", active && "bg-raised")}>
                      <button
                        type="button"
                        className={cn("h-9 w-9 shrink-0 text-lg", project.titleLine === index ? "text-accent" : "text-faint")}
                        aria-label="Строка с названием"
                        aria-pressed={project.titleLine === index}
                        onClick={() => patch({ titleLine: project.titleLine === index ? null : index })}
                      >
                        {project.titleLine === index ? "★" : "☆"}
                      </button>
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => engine.jumpLine(index)}>
                        {line}
                      </button>
                      <input
                        aria-label={`Метка строки ${index + 1}`}
                        key={`${project.id}-${index}-${cue ?? "x"}`}
                        defaultValue={cue == null ? "" : formatTime(cue, true)}
                        placeholder="—"
                        onBlur={(event) => {
                          const cues = project.cues.slice();
                          while (cues.length < lines.length) cues.push(null);
                          const raw = event.target.value.trim();
                          cues[index] = raw ? parseTime(raw) : null;
                          patch({ cues });
                        }}
                        className="h-9 w-[4.5rem] rounded-md border border-line bg-bg px-2 text-right font-mono text-xs"
                      />
                    </li>
                  );
                })}
              </ul>
              {lines.length ? (
                <button type="button" className={cn(ghost, "justify-self-start")} onClick={() => patch({ cues: lines.map(() => null) })}>
                  Сбросить метки
                </button>
              ) : null}
            </div>

            <div className="grid gap-3 rounded-lg border border-line bg-surface p-3">
              <p className="text-sm">Вид кадра</p>
              <div className="flex flex-wrap gap-2">
                {ASPECTS.map((aspect) => (
                  <button
                    key={aspect}
                    type="button"
                    className={cn(lineBtn, project.aspect === aspect && "border-accent text-accent")}
                    onClick={() => patch({ aspect })}
                  >
                    {aspect}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button key={preset.name} type="button" className={ghost} onClick={() => patch(preset.look)}>
                    {preset.name}
                  </button>
                ))}
              </div>
              <ColorRow label="Фон сверху" value={project.bg} onChange={(bg) => patch({ bg })} />
              <ColorRow label="Фон снизу" value={project.bg2} onChange={(bg2) => patch({ bg2 })} />
              <ColorRow label="Текущая строка" value={project.ink} onChange={(ink) => patch({ ink })} />
              <ColorRow label="Соседние строки" value={project.dim} onChange={(dim) => patch({ dim })} />
              <ColorRow label="Обводка" value={project.stroke} onChange={(stroke) => patch({ stroke })} />
              <label className="grid gap-1 text-xs text-muted">
                Размер шрифта: {Math.round(project.fontScale * 100)}%
                <input
                  type="range"
                  min={50}
                  max={180}
                  step={5}
                  value={Math.round(project.fontScale * 100)}
                  onChange={(event) => patch({ fontScale: Number(event.target.value) / 100 })}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Предыдущих строк: {project.linesBefore}
                <input
                  type="range"
                  min={0}
                  max={6}
                  step={1}
                  value={project.linesBefore}
                  onChange={(event) => patch({ linesBefore: Number(event.target.value) })}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Следующих строк: {project.linesAfter}
                <input
                  type="range"
                  min={0}
                  max={6}
                  step={1}
                  value={project.linesAfter}
                  onChange={(event) => patch({ linesAfter: Number(event.target.value) })}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Толщина обводки: {project.strokePx}
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={project.strokePx}
                  onChange={(event) => patch({ strokePx: Number(event.target.value) })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={project.vignette} onChange={(event) => patch({ vignette: event.target.checked })} />
                Затемнение по краям
              </label>
              <button
                type="button"
                className={cn(ghost, "justify-self-start")}
                onClick={() => patch({ ...DEFAULT_LOOK, corner: project.corner })}
              >
                Сбросить вид
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={ghost}
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${fileSlug(project.title)}.json`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Скачать вопрос
                </button>
                <button type="button" className={ghost} onClick={() => jsonInput.current?.click()}>
                  Открыть вопрос
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      <input ref={audioInput} hidden type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void onAudioFile(file);
      }} />
      <input ref={lyricsInput} hidden type="file" accept=".txt,.lrc,text/plain" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void onLyricsFile(file);
      }} />
      <input ref={jsonInput} hidden type="file" accept="application/json,.json" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void onJsonFile(file);
      }} />
    </div>
  );
}

function Library({
  projects,
  busy,
  onOpen,
  onDelete,
  onImport,
}: {
  projects: ProjectMeta[];
  busy: boolean;
  onOpen: (project: ProjectMeta) => void;
  onDelete: (id: string) => void;
  onImport: () => void;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{projects.length ? `${projects.length} в этом браузере` : "Пока пусто"}</p>
        <button type="button" className={lineBtn} onClick={onImport} disabled={busy}>
          Открыть файл вопроса
        </button>
      </div>
      {!projects.length ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-sm text-muted">
          Нажмите «Демо», чтобы увидеть ленту строк и подпись в углу, или «Новый вопрос» и загрузите песню.
        </p>
      ) : (
        <ul className="grid gap-2">
          {projects.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(item)}>
                <span className="block text-sm">{item.title || "Без названия"}</span>
                <span className="text-xs text-faint">
                  {item.aspect}
                  {item.corner ? ` · ${item.corner}` : ""}
                  {" · "}
                  {new Date(item.updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
              <button type="button" className={ghost} onClick={() => onOpen(item)}>
                Открыть
              </button>
              <button
                type="button"
                className={ghost}
                onClick={() => {
                  if (window.confirm(`Удалить «${item.title || "вопрос"}»?`)) onDelete(item.id);
                }}
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (next: number) => void }) {
  const [text, setText] = useState(formatTime(value, true));
  useEffect(() => setText(formatTime(value, true)), [value]);
  return (
    <label className="grid gap-1 text-xs text-muted">
      {label}
      <input
        className={field}
        value={text}
        inputMode="decimal"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = parseTime(text);
          if (next == null) setText(formatTime(value, true));
          else onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#333333";
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input type="color" value={safe} aria-label={label} className="color-swatch" onChange={(event) => onChange(event.target.value)} />
        <input
          value={text}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(event.target.value)) onChange(event.target.value);
          }}
          className="h-11 w-28 rounded-md border border-line bg-bg px-2 font-mono text-xs uppercase"
        />
      </span>
    </label>
  );
}
