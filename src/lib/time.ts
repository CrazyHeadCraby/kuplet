export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function formatTime(sec: number, tenths = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const whole = tenths ? Math.round(sec * 10) / 10 : Math.floor(sec);
  const rounded = tenths ? Math.round(whole * 10) / 10 : whole;
  const m = Math.floor(rounded / 60);
  const s = Math.floor(rounded % 60);
  const base = `${m}:${s.toString().padStart(2, "0")}`;
  if (!tenths) return base;
  const t = Math.round((rounded - Math.floor(rounded)) * 10) % 10;
  return `${base}.${t}`;
}

export function parseTime(value: string): number | null {
  const t = value.trim();
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const min = m[1] ? Number(m[1]) : 0;
  const sec = Number(m[2].replace(",", "."));
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return min * 60 + sec;
}

export function fileSlug(title: string) {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "kuplet";
}
