let sharedCtx: AudioContext | null = null;

/**
 * Crisp two-tone completion chime using Web Audio API (zero external audio asset required).
 */
export function playCompletionChime(volumePct = 80): void {
  const vol = Math.max(0, Math.min(1, volumePct / 100));
  if (vol <= 0) return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedCtx) sharedCtx = new AudioCtx();
    if (sharedCtx.state === 'suspended') {
      void sharedCtx.resume();
    }

    const now = sharedCtx.currentTime;
    const notes = [659.25, 880]; // E5 -> A5 subtle pleasant chime
    notes.forEach((freq, idx) => {
      const osc = sharedCtx!.createOscillator();
      const gain = sharedCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.09);

      const t0 = now + idx * 0.09;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.14 * vol, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);

      osc.connect(gain);
      gain.connect(sharedCtx!.destination);
      osc.start(t0);
      osc.stop(t0 + 0.26);
    });
  } catch {
    // ignore audio autoplay restrictions
  }
}
