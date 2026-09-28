export type Aspect = "16:9" | "9:16" | "1:1";

export type Look = {
  bg: string;
  bg2: string;
  ink: string;
  dim: string;
  stroke: string;
  strokePx: number;
  corner: string;
  vignette: boolean;
  fontScale: number;
  linesBefore: number;
  linesAfter: number;
};

export const DEFAULT_LOOK: Look = {
  bg: "#333333",
  bg2: "#333333",
  ink: "#f2f2f2",
  dim: "#8a8a8a",
  stroke: "#111111",
  strokePx: 0,
  corner: "",
  vignette: false,
  fontScale: 1,
  linesBefore: 3,
  linesAfter: 2,
};

export type ProjectMeta = {
  id: string;
  title: string;
  lyricsText: string;
  cues: (number | null)[];
  titleLine: number | null;
  start: number;
  end: number;
  aspect: Aspect;
  showNext: boolean;
  followCues: boolean;
  audioName: string;
  updatedAt: number;
} & Look;

function clampNum(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

export function blankProject(): ProjectMeta {
  return {
    id: crypto.randomUUID(),
    title: "Без названия",
    lyricsText: "",
    cues: [],
    titleLine: null,
    start: 0,
    end: 0,
    aspect: "16:9",
    showNext: true,
    followCues: false,
    audioName: "",
    updatedAt: Date.now(),
    ...DEFAULT_LOOK,
  };
}

export function normalizeProject(meta: Partial<ProjectMeta>): ProjectMeta {
  const base = blankProject();
  const aspect = meta.aspect === "9:16" || meta.aspect === "1:1" || meta.aspect === "16:9" ? meta.aspect : base.aspect;
  const strokePx = typeof meta.strokePx === "number" && Number.isFinite(meta.strokePx) ? meta.strokePx : base.strokePx;
  const bg = isHex(meta.bg) ? meta.bg : base.bg;
  const bg2 = isHex(meta.bg2) ? meta.bg2 : bg;
  return {
    ...base,
    ...meta,
    id: typeof meta.id === "string" && meta.id ? meta.id : base.id,
    title: typeof meta.title === "string" ? meta.title : base.title,
    lyricsText: typeof meta.lyricsText === "string" ? meta.lyricsText : "",
    cues: Array.isArray(meta.cues) ? meta.cues : [],
    titleLine: typeof meta.titleLine === "number" && Number.isFinite(meta.titleLine) ? meta.titleLine : null,
    start: typeof meta.start === "number" && Number.isFinite(meta.start) ? meta.start : 0,
    end: typeof meta.end === "number" && Number.isFinite(meta.end) ? meta.end : 0,
    aspect,
    showNext: meta.showNext !== false,
    followCues: Boolean(meta.followCues),
    audioName: typeof meta.audioName === "string" ? meta.audioName : "",
    updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now(),
    bg,
    bg2,
    ink: isHex(meta.ink) ? meta.ink : base.ink,
    dim: isHex(meta.dim) ? meta.dim : base.dim,
    stroke: isHex(meta.stroke) ? meta.stroke : base.stroke,
    strokePx: Math.min(10, Math.max(0, strokePx)),
    corner: typeof meta.corner === "string" ? meta.corner.replace(/[\r\n]+/g, " ").slice(0, 120) : "",
    vignette: meta.vignette === true,
    fontScale: clampNum(meta.fontScale, 0.5, 1.8, base.fontScale),
    linesBefore: Math.round(clampNum(meta.linesBefore, 0, 8, base.linesBefore)),
    linesAfter: Math.round(clampNum(meta.linesAfter, 0, 8, base.linesAfter)),
  };
}

const DB = "kuplet";
const META = "questions";
const AUDIO = "audio";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDb();
  const rows = await done(db.transaction(META).objectStore(META).getAll() as IDBRequest<ProjectMeta[]>);
  db.close();
  return rows.map((row) => normalizeProject(row)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(meta: ProjectMeta): Promise<void> {
  const db = await openDb();
  await done(db.transaction(META, "readwrite").objectStore(META).put({ ...meta, updatedAt: Date.now() }));
  db.close();
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, AUDIO], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(AUDIO).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await done(db.transaction(AUDIO, "readwrite").objectStore(AUDIO).put(blob, id));
  db.close();
}

export async function loadAudio(id: string): Promise<Blob | null> {
  const db = await openDb();
  const blob = await done(db.transaction(AUDIO).objectStore(AUDIO).get(id) as IDBRequest<Blob | undefined>);
  db.close();
  return blob ?? null;
}
