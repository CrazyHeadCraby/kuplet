const LRC = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;

export function parseLyrics(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

export function wordsPhrase(count: number): string {
  const n = Math.abs(count);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} слово`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} слова`;
  return `${count} слов`;
}

export function parseLrc(raw: string): { lines: string[]; times: number[] } | null {
  const lines: string[] = [];
  const times: number[] = [];
  let hits = 0;
  for (const row of raw.replace(/\r\n/g, "\n").split("\n")) {
    const m = row.trim().match(LRC);
    if (!m) continue;
    hits += 1;
    const text = m[4].trim();
    if (!text) continue;
    const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
    lines.push(text);
    times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
  }
  if (hits < 2 || lines.length < 2) return null;
  return { lines, times };
}

export function remapCues(
  prevLines: string[],
  nextLines: string[],
  cues: (number | null)[],
): (number | null)[] {
  const used = new Set<number>();
  return nextLines.map((line) => {
    for (let i = 0; i < prevLines.length; i++) {
      if (used.has(i) || prevLines[i] !== line) continue;
      used.add(i);
      return cues[i] ?? null;
    }
    return null;
  });
}
