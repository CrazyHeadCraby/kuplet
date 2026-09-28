export async function decodeAudio(file: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    const copy = await file.arrayBuffer();
    return await ctx.decodeAudioData(copy);
  } finally {
    await ctx.close();
  }
}

export function computePeaks(buffer: AudioBuffer, buckets = 1400): Float32Array {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const peaks = new Float32Array(buckets);
  const step = left.length / buckets;
  const stride = Math.max(1, Math.floor(step / 48));
  for (let i = 0; i < buckets; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(left.length, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = a; j < b; j += stride) {
      const v = Math.abs(left[j]!) + (right ? Math.abs(right[j]!) : 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  let top = 0;
  for (let i = 0; i < buckets; i++) if (peaks[i]! > top) top = peaks[i]!;
  if (top > 0) for (let i = 0; i < buckets; i++) peaks[i] = peaks[i]! / top;
  return peaks;
}

const DEMO_FREQS = [196, 247, 294, 330, 294, 247, 220, 196];

export async function synthDemo(): Promise<AudioBuffer> {
  const sampleRate = 44100;
  const duration = 16;
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * duration), sampleRate);
  DEMO_FREQS.forEach((freq, i) => {
    const t0 = 0.12 + i * 1.9;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.55);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 1.6);
  });
  return ctx.startRendering();
}

export const DEMO_LYRICS = [
  "Тихий город спит",
  "На мосту один",
  "Фонари горят",
  "На мосту один",
  "Вода несёт огни",
  "И город молчит",
].join("\n");

export const DEMO_CUES = [0.12, 2.02, 3.92, 5.82, 7.72, 9.62];
export const DEMO_AUDIO = "__demo__";
