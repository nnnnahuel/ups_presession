// The scan chime of /screen/v2: a short, soft tone synthesised on the page's own AudioContext
// (no audio files). The preview WAVs are rendered with this same function, so what is heard
// there is exactly what the wall plays.
//
// One note, E5, a sine with a faint second harmonic for body. It starts with a soft 8 ms swell
// (no click), settles from a hair sharp in the first 60 ms and fades out over 0.42 s. A milestone
// adds a second note a fifth higher (B5) 0.11 s later. Peak about -12.5 dBFS, about 17 LU under the
// announcements (chime -27.9 LUFS momentary max against -10/-11 for the phrases, since the voice was
// made louder; -12 to -14 for the numbers): soft, but heard over the music.
export const CHIME = {
  note: 659.25, // E5
  accent: 987.77, // B5, the milestone's second note
  accentDelay: 0.11, // s after the first note
  accentLevel: 0.8, // of the first note's level
  attack: 0.008, // s
  length: 0.42, // s until it has faded out
  settle: 0.06, // s to glide from slightly sharp to the note
  sharp: 1.004, // starting pitch ratio
  level: 0.22, // peak gain of the note (about -12.5 dBFS)
  harmonic: 0.14, // second harmonic, relative; it fades in 45% of the time
  lowpass: 5000, // Hz, takes the edge off
};

function tone(ctx, destination, when, frequency, level) {
  for (const [ratio, amount, length] of [
    [1, 1, CHIME.length],
    [2, CHIME.harmonic, CHIME.length * 0.45],
  ]) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency * ratio * CHIME.sharp, when);
    osc.frequency.exponentialRampToValueAtTime(frequency * ratio, when + CHIME.settle);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level * amount, when + CHIME.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
    osc.connect(gain).connect(destination);
    osc.start(when);
    osc.stop(when + length + 0.02);
    osc.onended = () => gain.disconnect();
  }
}

// Plays (or renders, on an OfflineAudioContext) one chime at context time `when`.
// Returns the context time at which it is silent again.
export function playChime(ctx, destination, when, { milestone = false } = {}) {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = CHIME.lowpass;
  filter.Q.value = 0.5;
  filter.connect(destination);
  tone(ctx, filter, when, CHIME.note, CHIME.level);
  if (milestone) tone(ctx, filter, when + CHIME.accentDelay, CHIME.accent, CHIME.level * CHIME.accentLevel);
  const end = when + (milestone ? CHIME.accentDelay : 0) + CHIME.length + 0.02;
  setTimeout(() => filter.disconnect(), Math.max(0, (end - ctx.currentTime) * 1000) + 100);
  return end;
}
