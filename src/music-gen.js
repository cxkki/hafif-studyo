// Procedural background music (no files needed).
//
// generateMusic({style, bpm, seed, key, duration}) -> Promise<Blob>  (WAV, 44.1 kHz, stereo, 16-bit)
//
// Layout: everything up to renderScore() is pure and environment-free (Node-testable):
//   normalizeMusicParams -> planTiming -> buildScore (arrangement as a list of note/drum events)
//   makeDrumKit / makeCrackle (sample synthesis in plain JS, seeded), reverb (Freeverb-style, JS)
//   masterDynamics / finalizeMix (glue comp, look-ahead limiter, normalise, fades) and encodeWav.
// Only renderScore() needs OfflineAudioContext (WebView2 / browser). Same params -> same audio:
// no Math.random, all randomness comes from a PRNG seeded by (seed, style).

export const MUSIC_GEN_VERSION = 1;
export const SAMPLE_RATE = 44100;
export const MUSIC_STYLES = ['upbeat', 'chill', 'epic', 'lofi', 'chiptune', 'cinematic'];

const MIN_DURATION = 3;
const MAX_DURATION = 180;

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mod = (n, m) => ((n % m) + m) % m;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** FNV-1a 32-bit hash of a string. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32) -> function returning 0..1. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];

// ---------------------------------------------------------------------------------------------
// Keys and harmony
// ---------------------------------------------------------------------------------------------

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const NOTE_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const PC_NAME = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * "A minor", "C# major", "Bb minor", "Am", "F#m", "Eb", "la minör"-style suffixes (min/maj/moll/dur/minör/majör).
 * Returns {pc, minor, name} or null when the text is not a key.
 */
export function parseKey(str) {
  const s = String(str ?? '').trim();
  const m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(.*)$/u.exec(s);
  if (!m) return null;
  let pc = NOTE_PC[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  else if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  pc = mod(pc, 12);
  const rest = m[3].trim();
  let minor;
  if (rest === '' || rest === 'M') minor = false;
  else if (rest === 'm') minor = true;
  else if (/^(min|minor|minör|moll|-)\.?$/iu.test(rest)) minor = true;
  else if (/^(maj|major|majör|dur)\.?$/iu.test(rest)) minor = false;
  else return null;
  return { pc, minor, name: `${PC_NAME[pc]} ${minor ? 'minor' : 'major'}` };
}

/**
 * Chord spec: a scale degree (0 = tonic) or {d, q:'maj'|'min'|'sus'} to override the quality
 * (e.g. the major V in a minor key, the borrowed iv in a major key).
 * Returns {root (pc), iv (semitone intervals), degs (scale degrees usable by the melody)}.
 */
export function chordInfo(key, spec, { seventh = false, ninth = false } = {}) {
  const scale = key.minor ? MINOR : MAJOR;
  const d = typeof spec === 'number' ? spec : spec.d;
  const q = typeof spec === 'number' ? null : spec.q || null;
  const deg = (k) => scale[mod(d + k, 7)] + 12 * Math.floor((d + k) / 7) - scale[mod(d, 7)];
  let third = deg(2);
  let fifth = deg(4);
  let sev = deg(6);
  if (q === 'maj') {
    third = 4;
    fifth = 7;
    sev = 10;
  } else if (q === 'min') {
    third = 3;
    fifth = 7;
    sev = 10;
  } else if (q === 'sus') third = 5;
  const iv = [0, third, fifth];
  if (seventh) iv.push(sev);
  if (ninth) iv.push(14);
  const root = mod(key.pc + scale[mod(d, 7)], 12);
  // Melody may land on diatonic chord tones only; with an altered third use root + fifth.
  const degs = q ? [mod(d, 7), mod(d + 4, 7)] : [mod(d, 7), mod(d + 2, 7), mod(d + 4, 7)];
  return { root, iv, degs };
}

/** Chord pitch classes placed into [lo, lo + 12), sorted (a close voicing). */
function voiceChord(ch, lo) {
  const out = ch.iv.map((i) => {
    const pc = mod(ch.root + i, 12);
    return lo + mod(pc - lo, 12);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

/** All chord tones inside [lo, hi), ascending. */
function chordTonesIn(ch, lo, hi) {
  const pcs = new Set(ch.iv.map((i) => mod(ch.root + i, 12)));
  const out = [];
  for (let m = lo; m < hi; m++) if (pcs.has(mod(m, 12))) out.push(m);
  return out;
}

/** The MIDI note of a chord's root inside [lo, lo + 12). */
const rootIn = (ch, lo) => lo + mod(ch.root - lo, 12);

// ---------------------------------------------------------------------------------------------
// Style definitions
// ---------------------------------------------------------------------------------------------

// Lead phrase rhythms: 2 bars on a 16th grid, [startStep, lengthInSteps].
const TPL = {
  pop: [
    [[0, 2], [3, 2], [6, 2], [8, 2], [10, 2], [12, 3], [16, 2], [19, 2], [22, 2], [24, 6]],
    [[0, 3], [3, 3], [6, 2], [8, 4], [12, 2], [14, 2], [16, 3], [19, 3], [22, 2], [24, 8]],
    [[2, 2], [4, 2], [6, 4], [10, 2], [12, 4], [18, 2], [20, 2], [22, 4], [26, 6]],
  ],
  sparse: [
    [[0, 6], [6, 2], [8, 8], [16, 4], [20, 4], [24, 8]],
    [[2, 2], [4, 4], [8, 2], [10, 6], [18, 2], [20, 4], [24, 8]],
    [[0, 4], [6, 4], [10, 6], [16, 3], [19, 3], [22, 10]],
  ],
  chip: [
    [[0, 2], [2, 2], [4, 1], [5, 1], [6, 2], [8, 2], [10, 2], [12, 4], [16, 2], [18, 2], [20, 2], [22, 2], [24, 2], [26, 2], [28, 4]],
    [[0, 3], [3, 3], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2], [16, 3], [19, 3], [22, 2], [24, 8]],
    [[0, 2], [2, 1], [3, 1], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2], [16, 2], [18, 1], [19, 1], [20, 2], [22, 2], [24, 8]],
  ],
  epic: [
    [[0, 6], [6, 2], [8, 8], [16, 6], [22, 2], [24, 8]],
    [[0, 4], [4, 4], [8, 4], [12, 4], [16, 12], [28, 4]],
    [[0, 3], [3, 1], [4, 8], [12, 4], [16, 3], [19, 1], [20, 12]],
  ],
};

// Drum patterns, 16 steps per bar. k kick, s snare, c clap, h closed hat, oh open hat (chorus),
// gh ghost hats (chorus), tom toms (chorus), boom big low hit.
const DRUMS = {
  upbeat: [
    { k: [0, 4, 8, 12], c: [4, 12], h: [2, 6, 10, 14], oh: [2, 6, 10, 14], gh: [1, 3, 5, 7, 9, 11, 13, 15] },
    { k: [0, 4, 8, 12], c: [4, 12], s: [15], h: [0, 2, 4, 6, 8, 10, 12, 14], oh: [6, 14], gh: [3, 7, 11, 15] },
    { k: [0, 4, 8, 12], c: [4, 12], h: [2, 6, 10, 14], oh: [10], gh: [0, 4, 7, 8, 12, 15] },
  ],
  chill: [
    { k: [0, 7, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], gh: [5, 13] },
    { k: [0, 6, 8], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], gh: [11, 15] },
  ],
  lofi: [
    { k: [0, 7, 10], s: [4, 12], h: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14], gh: [15] },
    { k: [0, 3, 10], s: [4, 12], h: [0, 2, 4, 6, 7, 8, 10, 12, 14, 15], gh: [9] },
    { k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 5, 6, 8, 10, 12, 13, 14], gh: [3] },
  ],
  chiptune: [
    { k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], gh: [1, 3, 5, 7, 9, 11, 13, 15] },
    { k: [0, 6, 8], s: [4, 12, 14], h: [0, 2, 4, 6, 8, 10, 12, 14], gh: [3, 7, 11, 15] },
  ],
  epic: [
    { boom: [0], k: [0, 10], s: [8], tom: [0, 3, 6, 10, 12, 14], gh: [2, 6, 10, 14] },
    { boom: [0], k: [0, 6], s: [8], tom: [0, 2, 4, 7, 10, 12, 13, 14], gh: [2, 6, 10, 14] },
  ],
  cinematic: [
    { boom: [0], k: [], s: [], tom: [8, 14], h: [], gh: [0, 2, 4, 6, 8, 10, 12, 14] },
    { boom: [0], k: [10], s: [], tom: [6, 8], h: [], gh: [2, 6, 10, 14] },
  ],
};

const P = (d, q) => ({ d, q });

/**
 * Per style: default bpm/key, harmony, parts and mix. Gains are linear, roughly balanced against
 * each other; the final mix is peak-normalised anyway.
 */
const STYLES = {
  upbeat: {
    bpm: 120,
    key: 'A minor',
    chordBars: 1,
    seventh: false,
    swing: 0,
    human: 0,
    tail: [0.6, 2.2],
    prog: {
      minor: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 5, 6], [0, 5, 3, 6]],
      major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [0, 3, 5, 4]],
    },
    cadence: { minor: 6, major: 4 },
    tpl: 'pop',
    lead: { range: [67, 86], waves: [{ type: 'sawtooth', detune: -11 }, { type: 'sawtooth', detune: 11 }, { type: 'square', ratio: 0.5, gain: 0.35 }], a: 0.004, dcy: 0.25, s: 0.55, r: 0.12, gain: 0.11, legato: 0.85, filter: { from: 5200, to: 1700, time: 0.22, q: 2 } },
    pad: { waves: 'sawtooth', spread: 12, lo: 55, a: 0.04, dcy: 0.6, s: 0.75, r: 0.25, gain: 0.03, lp: 2000 },
    bass: { patterns: [[[2, 2, 'r'], [6, 2, 'r'], [10, 2, 'r'], [14, 2, 'o']], [[0, 2, 'r'], [2, 2, 'r'], [4, 2, 'o'], [6, 2, 'r'], [8, 2, 'r'], [10, 2, 'r'], [12, 2, 'o'], [14, 2, '5']]], lo: 33, waves: [{ type: 'sawtooth' }, { type: 'sine', gain: 0.9 }], a: 0.004, dcy: 0.16, s: 0.5, r: 0.05, gain: 0.26, lp: 950, q: 3 },
    arp: { wave: 'square', lo: 64, hi: 86, rate: [2, 1], a: 0.002, dcy: 0.11, s: 0, r: 0.05, gain: 0.05, lp: 2800 },
    kit: 'house',
    drumMix: { kick: 0.95, snare: 0.35, clap: 0.5, hat: 0.2, ohat: 0.17, crash: 0.22, tom: 0, boom: 0 },
    fx: { verb: 1.4, damp: 0.35, wet: 1.0, delay: 0.22, delayBeats: 0.75, pump: 0.6, riser: true },
    send: { lead: 0.3, pad: 0.35, arp: 0.3, drums: 0.12 },
    mix: { drums: 0.9, bass: 0.95, pad: 2, arp: 3.9, lead: 1.6 },
  },
  chill: {
    bpm: 90,
    key: 'D major',
    chordBars: 1,
    seventh: true,
    swing: 0.12,
    human: 0.004,
    tail: [0.9, 2.8],
    prog: {
      major: [[0, 2, 5, 3], [3, 2, 1, 0], [1, 4, 0, 5], [0, 5, 3, 4]],
      minor: [[0, 5, 3, 6], [0, 3, 6, 2], [3, 6, 2, 5]],
    },
    cadence: { minor: 6, major: 4 },
    tpl: 'sparse',
    lead: { range: [72, 91], waves: [{ type: 'sine' }], fm: { ratio: 3.5, index: 1.6, decay: 0.5 }, a: 0.003, dcy: 1.1, s: 0.12, r: 0.5, gain: 0.15, legato: 1 },
    pad: { waves: 'triangle', spread: 8, lo: 57, a: 0.35, dcy: 1, s: 1, r: 0.9, gain: 0.05, lp: 2600 },
    bass: { patterns: [[[0, 6, 'r'], [6, 2, 'r'], [8, 4, '5'], [12, 4, 'r']], [[0, 10, 'r'], [10, 2, '5'], [12, 4, 'o']]], lo: 33, waves: [{ type: 'sine' }, { type: 'triangle', gain: 0.45 }], a: 0.01, dcy: 0.5, s: 0.6, r: 0.15, gain: 0.34, lp: 700, q: 1 },
    arp: { wave: 'triangle', lo: 69, hi: 90, rate: [2, 2], a: 0.003, dcy: 0.25, s: 0, r: 0.1, gain: 0.06, lp: 5000 },
    kit: 'soft',
    drumMix: { kick: 0.8, snare: 0.32, clap: 0, hat: 0.13, ohat: 0, crash: 0.12, tom: 0, boom: 0 },
    fx: { verb: 2.0, damp: 0.3, wet: 1.1, delay: 0.25, delayBeats: 0.75, pump: 0, riser: false },
    send: { lead: 0.45, pad: 0.4, arp: 0.4, drums: 0.15 },
    mix: { drums: 0.8, bass: 0.41, pad: 0.6, arp: 3.2, lead: 1 },
  },
  lofi: {
    bpm: 80,
    key: 'F major',
    chordBars: 1,
    seventh: true,
    ninth: true,
    swing: 0.3,
    human: 0.007,
    tail: [0.9, 2.8],
    prog: {
      major: [[1, 4, 0, 5], [3, 2, 1, 0], [0, 5, 1, 4], [3, 4, 2, 5]],
      minor: [[0, 3, 6, 2], [0, 5, 3, P(4, 'maj')], [3, 6, 2, 5]],
    },
    cadence: { minor: P(4, 'maj'), major: 4 },
    tpl: 'sparse',
    lead: { range: [64, 81], waves: [{ type: 'sine' }], fm: { ratio: 1, index: 1.1, decay: 0.35 }, a: 0.004, dcy: 1.3, s: 0.25, r: 0.3, gain: 0.15, legato: 1, wow: true },
    pad: { ep: true, lo: 53, comp: [[0, 10, 1], [10, 6, 0.75]], waves: [{ type: 'sine' }], fm: { ratio: 1, index: 0.9, decay: 0.3 }, a: 0.005, dcy: 1.4, s: 0.35, r: 0.25, gain: 0.07, lp: 3200, wow: true },
    bass: { patterns: [[[0, 6, 'r'], [7, 3, 'r'], [10, 4, '5'], [14, 2, 'r']], [[0, 9, 'r'], [10, 6, '5']]], lo: 33, waves: [{ type: 'sine' }, { type: 'triangle', gain: 0.5 }], a: 0.008, dcy: 0.4, s: 0.5, r: 0.12, gain: 0.38, lp: 520, q: 1 },
    arp: null,
    kit: 'lofi',
    drumMix: { kick: 0.9, snare: 0.45, clap: 0, hat: 0.16, ohat: 0, crash: 0, tom: 0, boom: 0 },
    fx: { verb: 1.2, damp: 0.55, wet: 2.25, delay: 0.12, delayBeats: 0.75, pump: 0, riser: false, lp: 3800, drive: 1.8, crackle: 0.05 },
    send: { lead: 0.3, pad: 0.3, arp: 0, drums: 0.1 },
    mix: { drums: 0.85, bass: 0.65, pad: 1.36, arp: 1, lead: 0.9 },
  },
  chiptune: {
    bpm: 140,
    key: 'C major',
    chordBars: 1,
    seventh: false,
    swing: 0,
    human: 0,
    tail: [0.5, 1.8],
    prog: {
      major: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 4]],
      minor: [[0, 5, 6, 0], [0, 3, 6, 2], [0, 6, 5, 6]],
    },
    cadence: { minor: P(4, 'maj'), major: 4 },
    tpl: 'chip',
    lead: { range: [69, 91], waves: [{ type: 'pulse25' }], a: 0.002, dcy: 0.12, s: 0.7, r: 0.03, gain: 0.085, legato: 0.78, vibrato: 16 },
    pad: null,
    bass: { patterns: [[[0, 2, 'r'], [2, 2, 'o'], [4, 2, 'r'], [6, 2, 'o'], [8, 2, 'r'], [10, 2, 'o'], [12, 2, 'r'], [14, 2, 'o']], [[0, 2, 'r'], [2, 2, 'r'], [4, 2, '5'], [6, 2, 'o'], [8, 2, 'r'], [10, 2, 'r'], [12, 2, '5'], [14, 2, 'o']]], lo: 45, waves: [{ type: 'triangle' }], a: 0.002, dcy: 0.05, s: 0.9, r: 0.02, gain: 0.36, legato: 0.85 },
    arp: { wave: 'pulse12', lo: 60, hi: 84, rate: [1, 1], a: 0.002, dcy: 0.05, s: 0.45, r: 0.02, gain: 0.04 },
    kit: 'chip',
    drumMix: { kick: 0.8, snare: 0.4, clap: 0, hat: 0.16, ohat: 0, crash: 0.12, tom: 0, boom: 0 },
    fx: { verb: 0.6, damp: 0.25, wet: 1.8, delay: 0.14, delayBeats: 0.5, pump: 0, riser: false },
    send: { lead: 0.15, pad: 0, arp: 0.1, drums: 0.05 },
    mix: { drums: 0.85, bass: 0.51, pad: 1, arp: 7.6, lead: 2.5 },
  },
  epic: {
    bpm: 100,
    key: 'D minor',
    chordBars: 1,
    seventh: false,
    swing: 0,
    human: 0,
    tail: [1.0, 3.0],
    prog: {
      minor: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 5, P(4, 'maj')], [5, 6, 0, 0]],
      major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, P(3, 'min'), 0, 4]],
    },
    cadence: { minor: P(4, 'maj'), major: 4 },
    tpl: 'epic',
    lead: { range: [62, 81], waves: [{ type: 'sawtooth', detune: -7 }, { type: 'sawtooth', detune: 7 }], a: 0.05, dcy: 0.5, s: 0.8, r: 0.25, gain: 0.09, legato: 0.95, filter: { from: 700, to: 2800, time: 0.14, q: 1 } },
    pad: { waves: 'sawtooth', spread: 13, lo: 50, a: 0.45, dcy: 1, s: 1, r: 1.0, gain: 0.03, lp: 2600, double: true },
    bass: { patterns: [[[0, 16, 'r']], [[0, 16, 'r']]], drive: [[0, 2, 'r'], [2, 2, 'r'], [4, 2, 'o'], [6, 2, 'r'], [8, 2, 'r'], [10, 2, 'r'], [12, 2, 'o'], [14, 2, 'r']], lo: 33, waves: [{ type: 'sawtooth' }, { type: 'sine', ratio: 0.5, gain: 1 }], a: 0.01, dcy: 0.3, s: 0.8, r: 0.2, gain: 0.26, lp: 420, q: 1 },
    arp: { wave: 'sawtooth', lo: 45, hi: 64, rate: [2, 1], a: 0.003, dcy: 0.1, s: 0.15, r: 0.05, gain: 0.055, lp: 1500, pats: [[0, 0, 2, 0, 1, 0, 2, 1], [0, 1, 0, 2, 0, 1, 0, 3]] },
    kit: 'epic',
    drumMix: { kick: 0.85, snare: 0.55, clap: 0, hat: 0.07, ohat: 0, crash: 0.25, tom: 0.5, boom: 0.9 },
    fx: { verb: 2.6, damp: 0.25, wet: 0.96, delay: 0, delayBeats: 0.75, pump: 0, riser: true },
    send: { lead: 0.4, pad: 0.45, arp: 0.25, drums: 0.3 },
    mix: { drums: 0.9, bass: 1.2, pad: 3.2, arp: 6, lead: 1.6 },
  },
  cinematic: {
    bpm: 84,
    key: 'C minor',
    chordBars: 2,
    seventh: false,
    swing: 0,
    human: 0,
    tail: [1.2, 3.4],
    prog: {
      minor: [[0, 5, 2, 6], [0, 3, 0, 5], [0, 5, 3, P(4, 'maj')], [5, 2, 6, 0]],
      major: [[0, 2, 3, P(3, 'min')], [0, 4, 5, 3], [3, 0, 4, 5]],
    },
    cadence: { minor: P(4, 'maj'), major: 4 },
    tpl: 'sparse',
    lead: { range: [67, 86], waves: [{ type: 'triangle' }, { type: 'sine', ratio: 2, gain: 0.3 }], a: 0.003, dcy: 1.5, s: 0.1, r: 0.6, gain: 0.15, legato: 1 },
    pad: { waves: 'sawtooth', spread: 9, lo: 48, a: 0.9, dcy: 1, s: 1, r: 1.6, gain: 0.035, lp: 1300 },
    bass: { patterns: [[[0, 16, 'r']], [[0, 12, 'r'], [12, 4, '5']]], lo: 28, waves: [{ type: 'sine' }, { type: 'sawtooth', gain: 0.25 }], a: 0.15, dcy: 1, s: 0.9, r: 0.8, gain: 0.34, lp: 260, q: 1 },
    arp: { wave: 'triangle', lo: 60, hi: 79, rate: [2, 2], a: 0.003, dcy: 0.5, s: 0, r: 0.2, gain: 0.07, lp: 3200, pats: [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3, 2, 1]] },
    kit: 'cine',
    drumMix: { kick: 0.6, snare: 0, clap: 0, hat: 0.06, ohat: 0, crash: 0.2, tom: 0.45, boom: 1 },
    fx: { verb: 3.0, damp: 0.2, wet: 0.93, delay: 0.18, delayBeats: 0.75, pump: 0, riser: true },
    send: { lead: 0.5, pad: 0.5, arp: 0.45, drums: 0.35 },
    mix: { drums: 0.85, bass: 0.8, pad: 2, arp: 3.5, lead: 1.3 },
  },
};

const ARP_PATS = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 2, 3, 4, 3, 2, 1], [0, 2, 4, 2], [3, 2, 1, 0], [0, 1, 2, 1, 3, 2, 4, 3]];

/** Loose names the AI or a user might write -> style. */
const STYLE_ALIASES = {
  happy: 'upbeat', pop: 'upbeat', edm: 'upbeat', dance: 'upbeat', energetic: 'upbeat', house: 'upbeat', cool: 'upbeat', fun: 'upbeat',
  calm: 'chill', relax: 'chill', relaxing: 'chill', ambient: 'chill', soft: 'chill', chillout: 'chill',
  lofihiphop: 'lofi', hiphop: 'lofi', jazzy: 'lofi', study: 'lofi',
  chip: 'chiptune', '8bit': 'chiptune', retro: 'chiptune', game: 'chiptune', arcade: 'chiptune', pixel: 'chiptune',
  trailer: 'epic', heroic: 'epic', orchestral: 'epic', action: 'epic', battle: 'epic',
  cinema: 'cinematic', film: 'cinematic', movie: 'cinematic', dramatic: 'cinematic', emotional: 'cinematic', sad: 'cinematic',
};

/** Default bpm / key per style (for UI and docs). */
export const STYLE_DEFAULTS = Object.fromEntries(MUSIC_STYLES.map((s) => [s, { bpm: STYLES[s].bpm, key: STYLES[s].key }]));

// ---------------------------------------------------------------------------------------------
// Parameters and timing
// ---------------------------------------------------------------------------------------------

/**
 * {style, bpm, seed, key, duration} -> fully specified params.
 * Unknown style -> "upbeat"; bpm clamped 60..180 (style default when missing); seed integer (default 1);
 * key from text or the style default; duration (s) clamped 3..180 (non-numbers such as "auto" -> 30).
 */
export function normalizeMusicParams(p = {}) {
  p = p && typeof p === 'object' ? p : {};
  const sKey = String(p.style ?? '').toLowerCase().trim();
  const compact = sKey.replace(/[\s_-]+/g, '');
  const style = MUSIC_STYLES.includes(compact) ? compact : STYLE_ALIASES[compact] || 'upbeat';
  const S = STYLES[style];
  let bpm = Math.round(Number(p.bpm));
  if (!Number.isFinite(bpm) || bpm <= 0) bpm = S.bpm;
  bpm = clamp(bpm, 60, 180);
  let seed = Math.trunc(Number(p.seed));
  if (!Number.isFinite(seed)) seed = 1;
  seed = clamp(seed, -2147483648, 2147483647);
  const key = parseKey(p.key) || parseKey(S.key);
  let duration = Number(p.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = 30;
  duration = Math.round(clamp(duration, MIN_DURATION, MAX_DURATION) * 100) / 100;
  return { style, bpm, seed, key: key.name, duration };
}

/**
 * Fits whole bars plus a ring-out tail into the duration, nudging the tempo as little as possible.
 * Returns {bars, barLen, bpm (effective), musicEnd (time of the final hit), tail}.
 */
export function planTiming(bpm, duration, tail = [0.6, 2.2]) {
  const barLen0 = 240 / bpm;
  const tMin = Math.min(tail[0], duration * 0.3);
  const tMax = Math.max(tMin, Math.min(tail[1], duration * 0.45));
  const lMin = duration - tMax;
  const lMax = duration - tMin;
  let best = null;
  const maxBars = Math.max(1, Math.ceil(lMax / (240 / 190)) + 1);
  for (let n = 1; n <= maxBars; n++) {
    const bl = clamp(barLen0, lMin / n, lMax / n);
    const eff = 240 / bl;
    if (eff < 50 || eff > 200) continue;
    const score = Math.abs(Math.log(bl / barLen0));
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && n > best.bars)) best = { score, bars: n, barLen: bl };
  }
  if (!best) best = { bars: 1, barLen: Math.max(0.5, lMax) };
  const musicEnd = best.bars * best.barLen;
  return { bars: best.bars, barLen: best.barLen, bpm: 240 / best.barLen, musicEnd, tail: duration - musicEnd };
}

/** Arrangement sections. Short pieces: light first bar, then full. Long: intro, verse/chorus/break cycle. */
export function planSections(n) {
  if (n <= 1) return [{ start: 0, len: 1, energy: 0.95, kind: 'chorus' }];
  if (n <= 2) return [{ start: 0, len: 1, energy: 0.6, kind: 'intro' }, { start: 1, len: 1, energy: 1, kind: 'chorus' }];
  if (n <= 8) return [{ start: 0, len: 1, energy: 0.6, kind: 'intro' }, { start: 1, len: n - 1, energy: 1, kind: 'chorus' }];
  const out = [];
  const intro = n >= 24 ? 4 : 2;
  out.push({ start: 0, len: intro, energy: 0.45, kind: 'intro' });
  const cycle = [
    ['verse', 0.75],
    ['chorus', 1],
    ['verse', 0.75],
    ['chorus', 1],
    ['break', 0.5],
    ['chorus', 1],
  ];
  // Section lengths: 8 bars while plenty is left; the remainder becomes a short verse (>= 4 bars, even)
  // plus a final chorus, so mid-length pieces still get a lift. Never a stub of 1-3 bars.
  const lens = [];
  let rem = n - intro;
  while (rem >= 16) {
    lens.push(8);
    rem -= 8;
  }
  if (rem > 8) {
    const first = Math.max(4, rem - 8 + ((rem - 8) % 2));
    lens.push(first, rem - first);
  } else if (rem >= 4 || !lens.length) lens.push(rem);
  else if (rem > 0) lens[lens.length - 1] += rem;
  let b = intro;
  let k = 0;
  for (const len of lens) {
    if (len <= 0) continue;
    let [kind, energy] = cycle[k % cycle.length];
    if (b + len >= n && kind !== 'chorus') {
      // The piece always ends on full energy.
      kind = 'chorus';
      energy = 1;
    }
    const prev = out[out.length - 1];
    if (prev.kind === kind && kind === 'chorus') prev.len += len; // no two choruses back to back
    else out.push({ start: b, len, energy, kind });
    b += len;
    k++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Score (arrangement -> events)
// ---------------------------------------------------------------------------------------------

/**
 * Builds the full arrangement. Pure and deterministic.
 * Returns {style, seed, key, bpm, bars, barLen, musicEnd, duration, sections, progression, events, pumps}.
 * events: {inst, t, d?, n?, v, ...} sorted by t. inst: kick snare clap hat ohat crash tom boom bass pad arp lead riser.
 */
export function buildScore(params) {
  const p = normalizeMusicParams(params);
  const S = STYLES[p.style];
  const key = parseKey(p.key);
  const rand = rng(hash32(`${p.seed}|${p.style}|score`));
  const timing = planTiming(p.bpm, p.duration, S.tail);
  const N = timing.bars;
  const barLen = timing.barLen;
  const six = barLen / 16;
  const sections = planSections(N);
  const secOf = new Array(N);
  for (const s of sections) for (let i = 0; i < s.len; i++) secOf[s.start + i] = s;
  const energy = (bar) => (bar >= 0 && bar < N ? secOf[bar].energy : 0);

  const progs = key.minor ? S.prog.minor : S.prog.major;
  const prog = pick(rand, progs);
  const cadence = key.minor ? S.cadence.minor : S.cadence.major;
  const chordOpts = { seventh: S.seventh, ninth: !!S.ninth };
  const chordSpecAt = (bar) => {
    if (bar === N - 1 && N >= 2) return cadence;
    const sec = secOf[clamp(bar, 0, N - 1)];
    if (sec.kind === 'intro') return 0; // the intro sits on the tonic, then the loop starts
    const i = Math.floor((bar - sec.start) / S.chordBars);
    return prog[mod(i, prog.length)];
  };
  const chordCache = new Map();
  const chordAt = (bar) => {
    if (bar >= N) return chordInfo(key, 0, chordOpts);
    if (!chordCache.has(bar)) chordCache.set(bar, chordInfo(key, chordSpecAt(bar), chordOpts));
    return chordCache.get(bar);
  };

  // Seeded variations.
  const drumPat = pick(rand, DRUMS[p.style]);
  const bassPat = S.bass ? pick(rand, S.bass.patterns) : null;
  const arpPat = S.arp ? pick(rand, S.arp.pats || ARP_PATS) : null;
  const tpl = pick(rand, TPL[S.tpl]);
  const deltasA = makeDeltas(rand, tpl, null);
  const deltasB = makeDeltas(rand, tpl, deltasA);

  // Swing moves odd 16ths later; humanisation is a tiny deterministic jitter.
  const T = (bar, step) => bar * barLen + step * six + (S.swing && Number.isInteger(step) && step % 2 === 1 ? S.swing * six : 0);
  const jitter = () => (S.human ? (rand() * 2 - 1) * S.human : 0);

  const events = [];
  const pumps = [];
  const push = (ev) => {
    if (ev.t < 0) ev.t = 0;
    if (ev.t < p.duration - 0.02) events.push(ev);
  };

  for (let bar = 0; bar < N; bar++) {
    const e = energy(bar);
    const sec = secOf[bar];
    const ch = chordAt(bar);
    const lastBar = bar === N - 1;
    const nextSec = bar + 1 < N ? secOf[bar + 1] : null;
    const fill = N >= 2 && (lastBar || (nextSec && nextSec !== sec && nextSec.energy >= e && e >= 0.55));
    const chorusStart = bar > 0 && bar === sec.start && e >= 0.95;

    // --- drums
    const hits = (name, steps, vel, minE, filt) => {
      if (!steps || e < minE) return;
      for (const st of steps) {
        if (filt && !filt(st)) continue;
        push({ inst: name, t: T(bar, st) + jitter(), v: clamp(vel(st) * (0.94 + rand() * 0.12), 0, 1) });
      }
    };
    const fillCut = (st) => !fill || st < 12;
    const accent = (st) => (st % 4 === 0 ? 1 : st % 2 === 0 ? 0.75 : 0.5);
    hits('boom', drumPat.boom, () => 1, 0.55);
    hits('kick', drumPat.k, (st) => (st % 4 === 0 ? 1 : 0.8), 0.55, (st) => !fill || st < 12 || p.style === 'upbeat');
    hits('snare', drumPat.s, (st) => (st % 4 === 0 ? 1 : 0.55), 0.7, fillCut);
    hits('clap', drumPat.c, () => 1, 0.7, fillCut);
    const openSet = e >= 0.95 && drumPat.oh ? new Set(drumPat.oh) : null;
    hits('hat', drumPat.h, (st) => (p.style === 'upbeat' ? (st % 4 === 2 ? 1 : 0.6) : accent(st)), 0.3, (st) => fillCut(st) && !(openSet && openSet.has(st)));
    if (openSet) hits('ohat', drumPat.oh, () => 1, 0.95, fillCut);
    hits('hat', drumPat.gh, (st) => (p.style === 'cinematic' || p.style === 'epic' ? 0.6 + 0.4 * (st % 4 === 0) : 0.35), p.style === 'cinematic' ? 0.75 : 0.95, fillCut);
    hits('tom', drumPat.tom, (st) => (st % 4 === 0 ? 1 : 0.7), 0.95, fillCut);
    if (fill) {
      if (p.style === 'epic' || p.style === 'cinematic') {
        [12, 13, 14, 15].forEach((st, i) => push({ inst: 'tom', t: T(bar, st), v: 0.6 + i * 0.13, pitch: 3 - i }));
        if (p.style === 'epic') push({ inst: 'snare', t: T(bar, 15), v: 0.9 });
      } else if (p.style === 'chill' || p.style === 'lofi') {
        push({ inst: 'snare', t: T(bar, 12) + jitter(), v: 0.9 });
        push({ inst: 'snare', t: T(bar, 14) + jitter(), v: 0.45 });
        push({ inst: 'snare', t: T(bar, 15) + jitter(), v: 0.7 });
      } else {
        [12, 13, 14, 15].forEach((st, i) => push({ inst: 'snare', t: T(bar, st), v: 0.5 + i * 0.16 }));
      }
    }
    if (chorusStart && S.drumMix.crash) push({ inst: 'crash', t: T(bar, 0), v: 1 });
    if (S.fx.pump && e >= 0.55) for (let b = 0; b < 4; b++) pumps.push(T(bar, b * 4));
    if (S.fx.riser && nextSec && nextSec !== sec && nextSec.energy >= 0.95 && N > 8) {
      push({ inst: 'riser', t: T(bar, 0), d: barLen, v: 0.8 });
    }

    // --- bass
    if (S.bass && e >= 0.55) {
      const pat = S.bass.drive && e >= 0.95 ? S.bass.drive : bassPat;
      const root = rootIn(ch, S.bass.lo);
      for (const [st, len, which] of pat) {
        if (fill && st >= 14 && p.style !== 'chiptune') continue;
        const n = which === 'o' ? root + 12 : which === '5' ? root + (ch.iv[2] || 7) : root;
        push({ inst: 'bass', t: T(bar, st) + jitter(), d: len * six * (S.bass.legato || 0.95), n, v: st % 4 === 0 ? 1 : 0.85 });
      }
    }

    // --- pad / chords
    if (S.pad) {
      const v = 0.6 + 0.4 * e;
      const notes = voiceChord(ch, S.pad.lo);
      if (S.pad.double && e >= 0.95) notes.push(notes[0] + 12, notes[notes.length - 1] + 12); // octave lift, cheap
      if (S.pad.comp) {
        for (const [st, len, vv] of S.pad.comp) push({ inst: 'pad', t: T(bar, st) + jitter(), d: len * six * 0.95, n: notes, v: v * vv });
      } else {
        // One sustained chord per run of identical chords (within the same section energy).
        const prevSame = bar > 0 && sameChord(chordAt(bar - 1), ch) && energy(bar - 1) === e;
        if (!prevSame) {
          let span = 1;
          while (bar + span < N && sameChord(chordAt(bar + span), ch) && energy(bar + span) === e) span++;
          push({ inst: 'pad', t: T(bar, 0), d: span * barLen - 0.02, n: notes, v });
        }
      }
    }

    // --- arp
    if (S.arp && e >= 0.5) {
      const tones = chordTonesIn(ch, S.arp.lo, S.arp.hi);
      const rate = e >= 0.95 ? S.arp.rate[1] : S.arp.rate[0];
      const v = e >= 0.95 ? 0.85 : 0.65;
      let k = 0;
      for (let st = 0; st < 16; st += rate, k++) {
        if (fill && st >= 12 && p.style !== 'chiptune') break;
        const idx = arpPat[k % arpPat.length];
        const n = tones[mod(idx, tones.length)];
        push({ inst: 'arp', t: T(bar, st) + jitter(), d: rate * six * 0.9, n, v: v * (st % 4 === 0 ? 1 : 0.8), pan: k % 2 ? 1 : -1 });
      }
    }

    // --- lead melody (call bars 0-1 / answer bars 2-3 of every 4 bars of a section)
    if (S.lead && e >= 0.9) {
      const u = mod(bar - sec.start, 4);
      const phraseStart = bar - (u % 2);
      const answer = u >= 2;
      const notes = phraseNotes({ tpl, deltas: answer ? deltasB : deltasA, startBar: phraseStart, chordAt, key, range: S.lead.range, answer });
      const half = u % 2;
      for (const nt of notes) {
        if (nt.st < half * 16 || nt.st >= half * 16 + 16) continue;
        const st = nt.st - half * 16;
        if (lastBar && st >= 12) continue; // leave room for the ending
        push({ inst: 'lead', t: T(bar, st) + jitter(), d: nt.len * six * S.lead.legato, n: nt.n, v: st % 4 === 0 ? 1 : 0.82 });
      }
    }
  }

  // --- ending: resolve on the tonic and ring out until the duration.
  const L = timing.musicEnd;
  const tail = timing.tail;
  const tonic = chordInfo(key, 0, chordOpts);
  const endDrum = p.style === 'epic' || p.style === 'cinematic' ? 'boom' : 'kick';
  push({ inst: endDrum, t: L, v: 1 });
  if (S.drumMix.crash) push({ inst: 'crash', t: L, v: 1 });
  if (S.pad) push({ inst: 'pad', t: L, d: 0.05, a: 0.02, r: tail * 0.9, n: voiceChord(tonic, S.pad.lo), v: 0.9, end: true });
  else if (S.arp) {
    // Chiptune: a quick tonic arpeggio flourish instead of a pad.
    chordTonesIn(tonic, S.arp.lo, S.arp.hi).slice(0, 4).forEach((n, i) => push({ inst: 'arp', t: L + i * six, d: tail * 0.6, n, v: 0.9, pan: i % 2 ? 1 : -1, r: tail * 0.3 }));
  }
  if (S.bass) push({ inst: 'bass', t: L, d: 0.05, a: 0.01, r: tail * 0.7, n: rootIn(tonic, S.bass.lo), v: 1, end: true });
  if (S.lead) {
    const lo = S.lead.range[0];
    const n = rootIn(tonic, lo + 5 > S.lead.range[1] ? lo : lo + 5);
    push({ inst: 'lead', t: L, d: Math.min(tail * 0.5, 1.2), r: tail * 0.45, n, v: 0.9, end: true });
  }

  events.sort((a, b) => a.t - b.t || (a.inst < b.inst ? -1 : a.inst > b.inst ? 1 : 0));
  return {
    style: p.style,
    seed: p.seed,
    key: p.key,
    params: p,
    bpm: timing.bpm,
    bars: N,
    barLen,
    musicEnd: L,
    tail,
    duration: p.duration,
    sections,
    progression: Array.from({ length: N }, (_, i) => chordSpecAt(i)),
    events,
    pumps,
  };
}

const sameChord = (a, b) => a.root === b.root && a.iv.join() === b.iv.join();

/** Melodic step sizes for a phrase; the answer keeps the first half of the call and re-writes the rest. */
function makeDeltas(rand, tpl, base) {
  const W = [
    [-2, 2],
    [-1, 3],
    [0, 1],
    [1, 3],
    [2, 2],
    [3, 1],
    [-3, 1],
    [4, 0.4],
    [-4, 0.4],
  ];
  const total = W.reduce((s, w) => s + w[1], 0);
  let cum = 0;
  return tpl.map(([st], i) => {
    if (i === 0) return 0;
    if (base && st < 16) return base[i];
    let r = rand() * total;
    let d = 0;
    for (const [v, w] of W) {
      r -= w;
      if (r <= 0) {
        d = v;
        break;
      }
    }
    // Pull back towards the centre so the line does not drift away.
    if (cum > 4 && d > 0) d = -d;
    if (cum < -4 && d < 0) d = -d;
    cum += d;
    return d;
  });
}

/** Pitches for one 2-bar phrase: walk the scale, snap strong notes to chord tones, end answers on the root. */
function phraseNotes({ tpl, deltas, startBar, chordAt, key, range, answer }) {
  const scale = key.minor ? MINOR : MAJOR;
  // Scale index 0 = the tonic at or above range[0].
  const base = range[0] + mod(key.pc - range[0], 12);
  const midiOf = (idx) => base + 12 * Math.floor(idx / 7) + scale[mod(idx, 7)];
  const isTone = (pos, ch) => ch.degs.includes(mod(pos, 7));
  // Nearest chord tone, searching first in the direction the melody is moving.
  const snap = (pos, ch, rootOnly, dir = 0) => {
    const ok = rootOnly ? [ch.degs[0]] : ch.degs;
    const offs = dir > 0 ? [0, 1, -1, 2, -2, 3, -3] : [0, -1, 1, -2, 2, -3, 3];
    for (const off of offs) if (ok.includes(mod(pos + off, 7))) return pos + off;
    return pos;
  };
  const fold = (pos) => {
    let guard = 0;
    while (midiOf(pos) > range[1] && guard++ < 8) pos -= 7;
    while (midiOf(pos) < range[0] && guard++ < 16) pos += 7;
    return pos;
  };
  let pos = snap(4, chordAt(startBar), false); // start around the 5th above the tonic
  let prev = null;
  const out = [];
  tpl.forEach(([st, len], i) => {
    const ch = chordAt(startBar + (st >= 16 ? 1 : 0));
    const step = i > 0 ? deltas[i] : 0;
    const dir = Math.sign(step);
    const strong = st % 4 === 0 || len >= 4;
    const last = answer && i === tpl.length - 1;
    pos += step;
    if (strong) pos = snap(pos, ch, false, dir);
    // A snap must not undo an intended step (that is what makes lines sound stuck on one note).
    if (!last && dir && prev !== null && pos === prev) {
      for (let k = 1; k <= 4; k++) {
        if (!strong || isTone(pos + dir * k, ch)) {
          pos += dir * k;
          break;
        }
      }
    }
    if (last) pos = snap(pos, ch, true, dir);
    pos = fold(pos);
    prev = pos;
    out.push({ st, len, n: midiOf(pos) });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sample synthesis (pure JS, seeded)
// ---------------------------------------------------------------------------------------------

/** In-place RBJ biquad (lowpass / highpass / bandpass). */
export function biquad(x, type, f, q, sr) {
  const w = (2 * Math.PI * clamp(f, 10, sr * 0.45)) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = (1 - cs) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = (1 + cs) / 2;
  } else {
    b0 = al;
    b1 = 0;
    b2 = -al;
  }
  const a0 = 1 + al;
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - al) / a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

function noise(n, rand, hold = 1) {
  const out = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (i % hold === 0) v = rand() * 2 - 1;
    out[i] = v;
  }
  return out;
}

function normalizePeak(x, target = 1, fadeEnd = true) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 1e-9) {
    const g = target / peak;
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  // 3 ms fade at the end against clicks.
  const f = fadeEnd ? Math.min(x.length, 132) : 0;
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  return x;
}

function synthKick(sr, rand, { f0, f1, pd, ad, len, click = 0.2, drive = 1, square = false }) {
  const n = Math.round(len * sr);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / pd);
    ph += (2 * Math.PI * f) / sr;
    let s = Math.sin(ph);
    if (square) s = Math.sign(s) * 0.6 + s * 0.4;
    s *= Math.exp(-t / ad);
    if (drive > 1) s = Math.tanh(s * drive) / Math.tanh(drive);
    if (click && t < 0.01) s += (rand() * 2 - 1) * click * Math.exp(-t / 0.0015);
    out[i] = s;
  }
  return normalizePeak(out);
}

function synthSnare(sr, rand, { tone = 185, td = 0.06, nd = 0.13, hp = 1200, lp = 0, len = 0.45, toneMix = 0.5, hold = 1 }) {
  const n = Math.round(len * sr);
  const nz = biquad(noise(n, rand, hold), 'highpass', hp, 0.7, sr);
  if (lp) biquad(nz, 'lowpass', lp, 0.7, sr);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (tone * (1 + 0.4 * Math.exp(-t / 0.01)))) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / td) * toneMix + nz[i] * Math.exp(-t / nd);
  }
  return normalizePeak(out);
}

function synthClap(sr, rand) {
  const n = Math.round(0.4 * sr);
  const nz = biquad(noise(n, rand), 'bandpass', 1300, 0.9, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 0;
    for (const o of [0, 0.011, 0.022]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.0045));
    if (t >= 0.03) env = Math.max(env, 0.7 * Math.exp(-(t - 0.03) / 0.09));
    out[i] = nz[i] * env;
  }
  return normalizePeak(out);
}

function synthNoiseHit(sr, rand, { len, d, hp, lp = 0, bp = 0, attack = 0, hold = 1 }) {
  const n = Math.round(len * sr);
  const nz = noise(n, rand, hold);
  if (hp) biquad(nz, 'highpass', hp, 0.7, sr);
  if (lp) biquad(nz, 'lowpass', lp, 0.7, sr);
  if (bp) biquad(nz, 'bandpass', bp, 0.6, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    nz[i] *= Math.exp(-t / d) * (attack ? Math.min(1, t / attack) : 1);
  }
  return normalizePeak(nz);
}

function synthTom(sr, rand, { f0 = 130, f1 = 80, len = 0.9, ad = 0.32 }) {
  const n = Math.round(len * sr);
  const nz = biquad(noise(n, rand), 'lowpass', 900, 0.7, sr);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.06);
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.tanh(1.6 * (Math.sin(ph) * Math.exp(-t / ad) + nz[i] * 0.5 * Math.exp(-t / 0.05)));
  }
  return normalizePeak(out);
}

function synthBoom(sr, rand, { len = 3, ad = 0.9 }) {
  const n = Math.round(len * sr);
  const nz = biquad(noise(n, rand), 'lowpass', 220, 0.7, sr);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 34 + 60 * Math.exp(-t / 0.12);
    ph += (2 * Math.PI * f) / sr;
    const s = Math.sin(ph) * Math.exp(-t / ad) + nz[i] * 1.5 * Math.exp(-t / 0.35) + (t < 0.006 ? (rand() * 2 - 1) * 0.3 : 0);
    out[i] = Math.tanh(s * 2) / Math.tanh(2);
  }
  return normalizePeak(out);
}

/**
 * Drum samples per style kit -> {kick, snare, clap, hat, ohat, crash, tom, boom} (Float32Array, peak 1, mono).
 * Missing entries are simply not used by that style.
 */
export function makeDrumKit(style, sr = SAMPLE_RATE, rand = rng(hash32(style + '|kit'))) {
  const kit = (STYLES[style] || STYLES.upbeat).kit;
  const k = {};
  if (kit === 'house') {
    k.kick = synthKick(sr, rand, { f0: 165, f1: 48, pd: 0.028, ad: 0.3, len: 0.55, click: 0.35, drive: 1.6 });
    k.snare = synthSnare(sr, rand, { tone: 200, nd: 0.1, hp: 1800 });
    k.clap = synthClap(sr, rand);
    k.hat = synthNoiseHit(sr, rand, { len: 0.12, d: 0.018, hp: 8000 });
    k.ohat = synthNoiseHit(sr, rand, { len: 0.5, d: 0.12, hp: 7000 });
    k.crash = synthNoiseHit(sr, rand, { len: 2.4, d: 0.75, hp: 4000, attack: 0.002 });
  } else if (kit === 'soft') {
    k.kick = synthKick(sr, rand, { f0: 120, f1: 50, pd: 0.03, ad: 0.22, len: 0.5, click: 0.08 });
    k.snare = synthSnare(sr, rand, { tone: 220, td: 0.03, nd: 0.07, hp: 2000, lp: 7000, toneMix: 0.35, len: 0.3 });
    k.hat = synthNoiseHit(sr, rand, { len: 0.1, d: 0.02, hp: 6500, lp: 11000 });
    k.crash = synthNoiseHit(sr, rand, { len: 2.4, d: 0.8, hp: 3500, lp: 9000, attack: 0.01 });
  } else if (kit === 'lofi') {
    k.kick = synthKick(sr, rand, { f0: 110, f1: 46, pd: 0.035, ad: 0.2, len: 0.45, click: 0.12, drive: 2 });
    k.snare = synthSnare(sr, rand, { tone: 190, td: 0.05, nd: 0.11, hp: 900, lp: 5000, toneMix: 0.4, len: 0.4 });
    k.hat = synthNoiseHit(sr, rand, { len: 0.12, d: 0.028, hp: 5500, lp: 9000 });
  } else if (kit === 'chip') {
    k.kick = synthKick(sr, rand, { f0: 220, f1: 50, pd: 0.02, ad: 0.09, len: 0.2, click: 0, square: true });
    k.snare = synthSnare(sr, rand, { tone: 240, td: 0.03, nd: 0.09, hp: 600, toneMix: 0.35, len: 0.25, hold: 5 });
    k.hat = synthNoiseHit(sr, rand, { len: 0.06, d: 0.018, hp: 3000, hold: 2 });
    k.crash = synthNoiseHit(sr, rand, { len: 1.2, d: 0.35, hp: 2000, hold: 3 });
  } else if (kit === 'epic') {
    k.kick = synthKick(sr, rand, { f0: 100, f1: 40, pd: 0.05, ad: 0.45, len: 1.0, click: 0.25, drive: 2.4 });
    k.snare = synthSnare(sr, rand, { tone: 170, td: 0.09, nd: 0.25, hp: 700, toneMix: 0.6, len: 0.8 });
    k.hat = synthNoiseHit(sr, rand, { len: 0.1, d: 0.02, hp: 7000 });
    k.crash = synthNoiseHit(sr, rand, { len: 3, d: 1.0, hp: 3000, attack: 0.003 });
    k.tom = synthTom(sr, rand, { f0: 130, f1: 72, ad: 0.38 });
    k.boom = synthBoom(sr, rand, { len: 2.5, ad: 0.7 });
  } else {
    // cinematic
    k.kick = synthKick(sr, rand, { f0: 90, f1: 38, pd: 0.06, ad: 0.5, len: 1.0, click: 0.1, drive: 1.8 });
    k.hat = synthNoiseHit(sr, rand, { len: 0.08, d: 0.012, hp: 6000, lp: 12000 });
    k.crash = synthNoiseHit(sr, rand, { len: 3.5, d: 1.2, hp: 2500, lp: 10000, attack: 0.25 });
    k.tom = synthTom(sr, rand, { f0: 110, f1: 60, ad: 0.5, len: 1.2 });
    k.boom = synthBoom(sr, rand, { len: 3.2, ad: 1.0 });
  }
  return k;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/**
 * Freeverb-style stereo reverb of a mono send (8 damped combs + 4 allpasses per side) -> [L, R], wet only.
 * seconds ~ RT60. Much cheaper than a ConvolverNode and deterministic.
 */
export function reverb(input, sr = SAMPLE_RATE, opts = {}) {
  return [reverbSide(input, sr, 0, opts), reverbSide(input, sr, 1, opts)];
}

/** One side (c = 0 left, 1 right: slightly longer delay lines) of reverb(). */
export function reverbSide(input, sr, c, { seconds = 1.5, damp = 0.3, predelay = 0.015, spread = 23 } = {}) {
  const n = input.length;
  const k = sr / 44100;
  const pre = Math.max(0, Math.round(predelay * sr));
  const avg = (COMBS.reduce((a, b) => a + b, 0) / COMBS.length) * k;
  const fb = clamp(Math.pow(10, (-3 * avg) / (sr * Math.max(0.1, seconds))), 0, 0.97);
  const d1 = 1 - damp;
  {
    const acc = new Float32Array(n);
    for (const len0 of COMBS) {
      const len = Math.max(1, Math.round((len0 + c * spread) * k));
      const buf = new Float32Array(len);
      let i = 0;
      let f = 0;
      for (let t = 0; t < n; t++) {
        const y = buf[i];
        f = y * d1 + f * damp;
        buf[i] = (t >= pre ? input[t - pre] * 0.015 : 0) + f * fb;
        if (++i === len) i = 0;
        acc[t] += y;
      }
    }
    for (const len0 of ALLPASSES) {
      const len = Math.max(1, Math.round((len0 + c * spread) * k));
      const buf = new Float32Array(len);
      let i = 0;
      for (let t = 0; t < n; t++) {
        const b = buf[i];
        const x = acc[t];
        buf[i] = x + b * 0.5;
        acc[t] = b - x;
        if (++i === len) i = 0;
      }
    }
    return acc;
  }
}

/** Vinyl noise loop: soft filtered hiss + sparse crackles. */
export function makeCrackle(sr, seconds, rand) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  let lp = 0;
  let pop = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.08 * (rand() * 2 - 1 - lp);
    if (rand() < 14 / sr) pop = (rand() < 0.5 ? -1 : 1) * (0.25 + rand() * 0.75);
    else pop *= 0.82;
    out[i] = lp * 0.35 + pop;
  }
  // Seamless loop: short crossfade of the ends.
  const f = Math.min(Math.round(sr * 0.02), n >> 1);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    out[i] = out[i] * k + out[n - f + i] * (1 - k);
  }
  return normalizePeak(out.slice(0, n - f), 1, false);
}

// ---------------------------------------------------------------------------------------------
// Mixdown helpers + WAV
// ---------------------------------------------------------------------------------------------

/**
 * Master dynamics, in place on [L, R]: gentle glue compression (2:1 above RMS + 6 dB, 5 ms / 120 ms)
 * then a 3 ms look-ahead limiter taking the loudest peaks down by up to 3 dB. Pure JS (cheap, deterministic).
 */
export function masterDynamics(chs, sr = SAMPLE_RATE) {
  const L = chs[0];
  const R = chs[1] || chs[0];
  const n = L ? L.length : 0;
  if (!n) return;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += L[i] * L[i] + R[i] * R[i];
  const rms = Math.sqrt(sum / (2 * n));
  if (!(rms > 1e-6)) return;
  const thr = rms * 2;
  const att = Math.exp(-1 / (0.005 * sr));
  const rel = Math.exp(-1 / (0.12 * sr));
  let env = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
    const g = env > thr ? Math.sqrt(thr / env) : 1;
    L[i] *= g;
    if (R !== L) R[i] *= g;
    const b = a * g;
    if (b > peak) peak = b;
  }
  // Limiter: required gain per sample, ramped down ahead of each peak (backward pass) and released slowly (forward pass).
  const lthr = peak * 0.708;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    g[i] = a > lthr ? lthr / a : 1;
  }
  const attStep = 1 / Math.max(1, Math.round(0.003 * sr));
  for (let i = n - 2; i >= 0; i--) if (g[i] > g[i + 1] + attStep) g[i] = g[i + 1] + attStep;
  const relStep = 1 / (0.25 * sr);
  for (let i = 1; i < n; i++) if (g[i] > g[i - 1] + relStep) g[i] = g[i - 1] + relStep;
  for (let i = 0; i < n; i++) {
    L[i] *= g[i];
    if (R !== L) R[i] *= g[i];
  }
}

/**
 * In place: master dynamics, then peak-normalise to target (max x4 gain), 4 ms fade-in and 80 ms fade-out.
 * Guarantees |sample| <= target, so the 16-bit file never clips.
 */
export function finalizeMix(chs, sr = SAMPLE_RATE, target = 0.891) {
  // A stray NaN/Infinity would turn the dynamics' RMS into NaN (and skip compression): zero them first.
  for (const ch of chs) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
  masterDynamics(chs, sr);
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  const g = peak > 1e-6 ? Math.min(4, target / peak) : 1;
  const n = chs[0] ? chs[0].length : 0;
  const fin = Math.min(n, Math.round(sr * 0.004));
  const fout = Math.min(n, Math.round(sr * 0.08));
  for (const ch of chs) {
    for (let i = 0; i < n; i++) {
      let k = g;
      if (i < fin) k *= i / fin;
      if (i >= n - fout) k *= (n - 1 - i) / fout;
      const v = ch[i] * k;
      ch[i] = Number.isFinite(v) ? v : 0;
    }
  }
  return { peak, gain: g };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** PCM WAV (16-bit) from channel arrays of floats in -1..1 -> ArrayBuffer. */
export function encodeWav(channels, sampleRate = SAMPLE_RATE) {
  const nCh = channels.length;
  const n = nCh ? channels[0].length : 0;
  const dataBytes = n * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  const q = (s) => {
    s = s > 1 ? 1 : s < -1 ? -1 : s || 0;
    return Math.round(s < 0 ? s * 32768 : s * 32767);
  };
  if (LITTLE_ENDIAN) {
    const pcm = new Int16Array(buf, 44, n * nCh);
    let o = 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) pcm[o++] = q(channels[c][i]);
  } else {
    let o = 44;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < nCh; c++) {
        v.setInt16(o, q(channels[c][i]), true);
        o += 2;
      }
  }
  return buf;
}

/** Cache-friendly file name, e.g. "muzik-upbeat-120-1-1a2b3c4d.wav" (changes with any param or the generator version). */
export function musicFileName(params = {}, duration) {
  const p = normalizeMusicParams({ ...(params || {}), duration: duration ?? params?.duration });
  const h = hash32(`v${MUSIC_GEN_VERSION}|${p.style}|${p.bpm}|${p.seed}|${p.key}|${p.duration.toFixed(2)}`).toString(16).padStart(8, '0');
  return `muzik-${p.style}-${p.bpm}-${p.seed}-${h}.wav`;
}

/** Exact size in bytes of the WAV generateMusic() makes for this duration (to spot a truncated cached file). */
export function musicWavBytes(duration) {
  const d = normalizeMusicParams({ duration }).duration;
  return 44 + Math.max(1, Math.ceil(d * SAMPLE_RATE)) * 2 * 2;
}

// ---------------------------------------------------------------------------------------------
// Rendering (OfflineAudioContext)
// ---------------------------------------------------------------------------------------------

function pulseWave(ctx, duty) {
  const N = 48;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let k = 1; k < N; k++) {
    real[k] = (2 * Math.sin(2 * Math.PI * k * duty)) / (Math.PI * k);
    imag[k] = (2 * (1 - Math.cos(2 * Math.PI * k * duty))) / (Math.PI * k);
  }
  return ctx.createPeriodicWave(real, imag);
}

function tanhCurve(drive) {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}

const REVERB_LEVEL = 1.4;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/** Gain envelope; returns the time after which the voice is silent. */
function adsr(p, t, d, peak, a, dcy, s, r) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (s < 1 && dcy > 0) p.setTargetAtTime(peak * s, t + a, dcy / 3);
  const rel = Math.max(t + d, t + a + 0.002);
  p.setTargetAtTime(0, rel, Math.max(0.005, r / 4));
  return rel + Math.max(0.03, r * 1.6);
}

/** Renders a score to stereo Float32Arrays [L, R] (not yet normalised). Needs OfflineAudioContext. */
export async function renderScore(score, { reverb: withReverb = true } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('Music generation needs OfflineAudioContext (browser / WebView2).');
  const sr = SAMPLE_RATE;
  const dur = score.duration;
  const length = Math.max(1, Math.ceil(dur * sr));
  const ctx = new OAC(3, length, sr);
  const S = STYLES[score.style];
  const beat = score.barLen / 4;

  const mono = (arr) => {
    const b = ctx.createBuffer(1, Math.max(1, arr.length), sr);
    b.getChannelData(0).set(arr);
    return b;
  };
  const kitBuf = {};
  const kit = makeDrumKit(score.style, sr, rng(hash32(`${score.seed}|${score.style}|kit`)));
  for (const k of Object.keys(kit)) kitBuf[k] = mono(kit[k]);
  const gainNode = (v, dest) => {
    const g = ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  };
  const filterNode = (type, f, q, dest) => {
    const n = ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    if (dest) n.connect(dest);
    return n;
  };
  const panNode = (pan, dest) => {
    const n = ctx.createStereoPanner();
    n.pan.value = pan;
    if (dest) n.connect(dest);
    return n;
  };

  // --- master: pre -> highpass -> (lofi lowpass + tape drive) -> out channels 0/1.
  // Reverb send -> out channel 2. Reverb, compression and limiting happen in JS afterwards (cheaper than
  // ConvolverNode + DynamicsCompressorNode, which cost more than all the notes together).
  const pre = gainNode(0.7);
  let tail = filterNode('highpass', 30, 0.7);
  pre.connect(tail);
  if (S.fx.lp) {
    const lp = filterNode('lowpass', S.fx.lp, 0.6);
    tail.connect(lp);
    tail = lp;
  }
  if (S.fx.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = tanhCurve(S.fx.drive);
    tail.connect(ws);
    tail = ws;
  }
  const merger = ctx.createChannelMerger(3);
  const split = ctx.createChannelSplitter(2);
  tail.connect(split);
  split.connect(merger, 0, 0);
  split.connect(merger, 1, 1);
  const revIn = gainNode(1);
  revIn.channelCount = 1;
  revIn.channelCountMode = 'explicit';
  revIn.connect(merger, 0, 2);
  ctx.destination.channelInterpretation = 'discrete';
  merger.connect(ctx.destination);
  const send = (src, amount) => (amount > 0 ? src.connect(gainNode(amount, revIn)) : null);

  // --- tempo delay for the lead
  let delIn = null;
  if (S.fx.delay) {
    delIn = gainNode(1);
    const dl = ctx.createDelay(2);
    dl.delayTime.value = Math.min(1.9, beat * S.fx.delayBeats);
    const dlp = filterNode('lowpass', 2600, 0.5);
    const fb = gainNode(0.33);
    delIn.connect(dl);
    dl.connect(dlp);
    dlp.connect(fb);
    fb.connect(dl);
    dlp.connect(gainNode(S.fx.delay, panNode(0.3, pre)));
  }

  // --- buses
  const drumBus = gainNode(S.mix.drums, pre);
  const drumVerb = gainNode(1, drumBus);
  send(drumVerb, S.send.drums);
  const hatBus = panNode(0.18, drumBus);
  const music = gainNode(1, pre); // sidechain-style pumping lives here
  const bassBus = S.bass && S.bass.lp ? filterNode('lowpass', S.bass.lp, S.bass.q || 1, gainNode(S.mix.bass, music)) : gainNode(S.mix.bass, music);
  let padL = null;
  let padR = null;
  if (S.pad) {
    const padOut = gainNode(S.mix.pad, music);
    const padF = filterNode('lowpass', S.pad.lp || 4000, 0.6, padOut);
    send(padOut, S.send.pad);
    padL = panNode(-0.45, padF);
    padR = panNode(0.45, padF);
  }
  let arpL = null;
  let arpR = null;
  if (S.arp) {
    const arpOut = gainNode(S.mix.arp, music);
    const arpF = S.arp.lp ? filterNode('lowpass', S.arp.lp, 0.8, arpOut) : arpOut;
    send(arpOut, S.send.arp);
    arpL = panNode(-0.35, arpF);
    arpR = panNode(0.35, arpF);
  }
  const leadBus = gainNode(S.mix.lead, music);
  send(leadBus, S.send.lead);
  if (delIn) leadBus.connect(delIn);

  // --- modulation sources (always-on, cheap)
  let wow = null;
  if (S.lead?.wow || S.pad?.wow) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.55;
    wow = gainNode(9);
    lfo.connect(wow);
    lfo.start(0);
    lfo.stop(dur);
  }
  let vib = null;
  if (S.lead?.vibrato) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    vib = gainNode(S.lead.vibrato);
    lfo.connect(vib);
    lfo.start(0);
    lfo.stop(dur);
  }
  const waves = {};
  const makeOsc = (type) => {
    const o = ctx.createOscillator();
    if (type === 'pulse25' || type === 'pulse12') {
      waves[type] = waves[type] || pulseWave(ctx, type === 'pulse25' ? 0.25 : 0.125);
      o.setPeriodicWave(waves[type]);
    } else o.type = type;
    return o;
  };

  // --- sidechain pump: dip the music bus on every beat with a kick
  if (S.fx.pump && score.pumps.length) {
    const depth = S.fx.pump;
    const curve = new Float32Array(48);
    for (let i = 0; i < curve.length; i++) {
      const k = i / (curve.length - 1);
      curve[i] = k < 0.04 ? 1 - depth * (k / 0.04) : 1 - depth * Math.exp(-(k - 0.04) * 5.5);
    }
    curve[0] = 1;
    curve[curve.length - 1] = 1;
    const len = beat * 0.9;
    let last = -1;
    for (const t of score.pumps) {
      if (t < last + len + 0.001 || t + len >= dur) continue;
      music.gain.setValueCurveAtTime(curve, t, len);
      last = t;
    }
  }

  // Voices are created just in time (see the suspend loop below) and disconnected once silent, so the
  // render graph only ever holds the notes that are sounding — this is what keeps rendering fast.
  const live = []; // {end, nodes, params: [[source, AudioParam]]}
  const track = (end, nodes, params = []) => live.push({ end, nodes, params });
  const sweep = (now) => {
    for (let i = live.length - 1; i >= 0; i--) {
      const v = live[i];
      if (v.end > now) continue;
      for (const n of v.nodes) n.disconnect();
      for (const [s, prm] of v.params) s.disconnect(prm);
      live[i] = live[live.length - 1];
      live.pop();
    }
  };

  /** One synth voice: oscillators (+ optional FM, filter) into an ADSR gain. */
  const voice = (dest, ev, spec, hz, peak, extra = {}) => {
    const t = ev.t;
    const a = ev.a ?? spec.a;
    const r = ev.r ?? spec.r;
    const d = Math.max(ev.d || 0, a + 0.005);
    const nodes = [];
    const params = [];
    const g = ctx.createGain();
    g.gain.value = 0;
    nodes.push(g);
    const end = Math.min(dur + 0.05, adsr(g.gain, t, d, peak, a, spec.dcy, spec.s, r));
    if (spec.filter) {
      const f = filterNode('lowpass', spec.filter.from, spec.filter.q || 1, dest);
      f.frequency.setValueAtTime(spec.filter.from, t);
      f.frequency.exponentialRampToValueAtTime(spec.filter.to, t + spec.filter.time);
      g.connect(f);
      nodes.push(f);
    } else g.connect(dest);
    const carriers = [];
    for (const w of extra.waves || spec.waves) {
      const o = makeOsc(w.type);
      o.frequency.value = hz * (w.ratio || 1);
      if (w.detune) o.detune.value = w.detune;
      if (spec.wow && wow) {
        wow.connect(o.detune);
        params.push([wow, o.detune]);
      }
      if (extra.vib && vib) {
        vib.connect(o.detune);
        params.push([vib, o.detune]);
      }
      if (w.gain != null && w.gain !== 1) {
        const wg = gainNode(w.gain, g);
        o.connect(wg);
        nodes.push(wg);
      } else o.connect(g);
      o.start(t);
      o.stop(end);
      carriers.push(o);
      nodes.push(o);
    }
    if (spec.fm) {
      const m = ctx.createOscillator();
      m.frequency.value = hz * spec.fm.ratio;
      const mg = ctx.createGain();
      mg.gain.value = 0;
      mg.gain.setValueAtTime(hz * spec.fm.index, t);
      mg.gain.setTargetAtTime(hz * spec.fm.index * 0.08, t, spec.fm.decay / 3);
      m.connect(mg);
      for (const c of carriers) mg.connect(c.frequency);
      m.start(t);
      m.stop(end);
      nodes.push(m, mg);
    }
    track(end, nodes, params);
  };

  /** Sustained chord: one envelope per side, two detuned oscillators per note for width. */
  const padChord = (ev) => {
    const spec = S.pad;
    const peak = spec.gain * ev.v;
    if (spec.ep) {
      ev.n.forEach((n, i) => voice(i % 2 ? padR : padL, ev, spec, midiHz(n), peak));
      return;
    }
    const a = ev.a ?? spec.a;
    const r = ev.r ?? spec.r;
    const d = Math.max(ev.d, a + 0.005);
    const gl = gainNode(0, padL);
    const gr = gainNode(0, padR);
    const nodes = [gl, gr];
    const end = Math.min(dur + 0.05, adsr(gl.gain, ev.t, d, peak, a, spec.dcy, spec.s, r));
    adsr(gr.gain, ev.t, d, peak, a, spec.dcy, spec.s, r);
    for (const n of ev.n) {
      for (const [g, det] of [
        [gl, -spec.spread],
        [gr, spec.spread],
      ]) {
        const o = makeOsc(spec.waves);
        o.frequency.value = midiHz(n);
        o.detune.value = det;
        o.connect(g);
        o.start(ev.t);
        o.stop(end);
        nodes.push(o);
      }
    }
    track(end, nodes);
  };

  const drum = (ev) => {
    const name = ev.inst;
    const b = kitBuf[name];
    const lvl = S.drumMix[name] || 0;
    if (!b || !lvl) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const rate = ev.pitch ? 1 + 0.12 * ev.pitch : 1; // descending tom fills
    src.playbackRate.value = rate;
    const dest = name === 'hat' || name === 'ohat' ? hatBus : name === 'kick' || name === 'boom' ? drumBus : drumVerb;
    const g = gainNode(lvl * ev.v, dest);
    src.connect(g);
    src.start(ev.t);
    track(ev.t + b.duration / rate + 0.01, [src, g]);
  };

  let noiseBuf = null;
  const riser = (ev) => {
    noiseBuf = noiseBuf || mono(noise(sr * 2, rng(hash32('riser'))));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = filterNode('bandpass', 300, 1.2);
    bp.frequency.setValueAtTime(300, ev.t);
    bp.frequency.exponentialRampToValueAtTime(7000, ev.t + ev.d);
    const g = gainNode(0);
    g.gain.setValueAtTime(0, ev.t);
    g.gain.linearRampToValueAtTime(0.12 * ev.v, ev.t + ev.d * 0.95);
    g.gain.linearRampToValueAtTime(0, ev.t + ev.d);
    src.connect(bp);
    bp.connect(g);
    g.connect(drumBus);
    const sg = send(g, 0.4);
    const end = Math.min(dur, ev.t + ev.d + 0.01);
    src.start(ev.t);
    src.stop(end);
    track(end + 0.01, sg ? [src, bp, g, sg] : [src, bp, g]);
  };

  if (S.fx.crackle) {
    const src = ctx.createBufferSource();
    src.buffer = mono(makeCrackle(sr, 3.7, rng(hash32(`${score.seed}|crackle`))));
    src.loop = true;
    src.connect(gainNode(S.fx.crackle, pre));
    src.start(0);
    src.stop(dur);
  }

  const play = (ev) => {
    if (ev.t >= dur) return;
    switch (ev.inst) {
      case 'bass':
        voice(bassBus, ev, S.bass, midiHz(ev.n), S.bass.gain * ev.v);
        break;
      case 'pad':
        if (S.pad) padChord(ev);
        break;
      case 'arp':
        if (S.arp) voice(ev.pan > 0 ? arpR : arpL, ev, S.arp, midiHz(ev.n), S.arp.gain * ev.v, { waves: [{ type: S.arp.wave }] });
        break;
      case 'lead':
        voice(leadBus, ev, S.lead, midiHz(ev.n), S.lead.gain * ev.v, { vib: true });
        break;
      case 'riser':
        riser(ev);
        break;
      default:
        drum(ev);
    }
  };

  // Schedule in 1 s chunks: the render pauses at each chunk start, the next chunk's notes are created
  // and finished voices are dropped. Events are sorted by time.
  const CHUNK = 1;
  const events = score.events;
  let next = 0;
  let failure = null;
  const scheduleUntil = (tEnd) => {
    while (next < events.length && events[next].t < tEnd) play(events[next++]);
  };
  scheduleUntil(CHUNK);
  if (typeof ctx.suspend === 'function') {
    for (let k = 1; k * CHUNK < dur - 0.05; k++) {
      const at = k * CHUNK;
      ctx.suspend(at).then(() => {
        try {
          scheduleUntil(at + CHUNK);
          sweep(at);
        } catch (e) {
          failure = failure || e;
        } finally {
          ctx.resume();
        }
      });
    }
  } else scheduleUntil(Infinity);

  const out = await ctx.startRendering();
  if (failure) throw failure;
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  // Heavy JS stages yield in between so the UI stays responsive on long pieces.
  const vopts = { seconds: S.fx.verb, damp: S.fx.damp ?? 0.3 };
  await yieldToUi();
  const wl = reverbSide(out.getChannelData(2), sr, 0, vopts);
  await yieldToUi();
  const wr = reverbSide(out.getChannelData(2), sr, 1, vopts);
  if (S.fx.lp) {
    biquad(wl, 'lowpass', S.fx.lp, 0.6, sr);
    biquad(wr, 'lowpass', S.fx.lp, 0.6, sr);
  }
  const wg = withReverb ? S.fx.wet * REVERB_LEVEL : 0;
  for (let i = 0; i < L.length; i++) {
    L[i] += wl[i] * wg;
    R[i] += wr[i] * wg;
  }
  return [L, R];
}

// ---------------------------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------------------------

const memo = new Map(); // fileName -> Promise<Blob>; small, so live re-applies do not re-render

/**
 * Generates the music as a WAV Blob (44.1 kHz, stereo, 16-bit). Deterministic for the same params.
 * params: {style, bpm, seed, key, duration (seconds; "auto"/missing -> 30, clamped 3..180)}.
 */
export function generateMusic(params = {}) {
  const name = musicFileName(params);
  if (memo.has(name)) return memo.get(name);
  const job = (async () => {
    const score = buildScore(params);
    const chs = await renderScore(score);
    await yieldToUi();
    finalizeMix(chs, SAMPLE_RATE);
    await yieldToUi();
    return new Blob([encodeWav(chs, SAMPLE_RATE)], { type: 'audio/wav' });
  })();
  memo.set(name, job);
  job.catch(() => memo.delete(name));
  while (memo.size > 3) memo.delete(memo.keys().next().value);
  return job;
}
