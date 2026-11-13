// KAN-826: limits and the error type of the finish step.
// FinishError messages are written by this code (never copied from a file name or user text) so they are safe to show.
export const FINISH_LIMITS = Object.freeze({
  maxShots: 60,                         // same cap as the Shot Spec validator
  maxSeconds: 600,                      // 10 minutes of picture and of voice
  maxOverlayText: 80,                   // characters per overlay label
  maxCaptionWord: 60,                   // characters per spoken word in the timing file
  maxWords: 20000,                      // words in the timing file
  maxOverlays: 200,                     // overlay labels in one Episode
  maxFileBytes: 512 * 1024 * 1024,      // one shot video, voice or bed file
  maxTimingBytes: 4 * 1024 * 1024,      // the timing JSON
  maxFontBytes: 25 * 1024 * 1024,       // the font copied next to the filter files
  stderrCapBytes: 64 * 1024,            // the tail of ffmpeg stderr that is kept
  probeTimeoutMs: 30 * 1000,            // ffmpeg -i
  stepTimeoutMs: 10 * 60 * 1000,        // mix, loudness, encode
});

export class FinishError extends Error {
  constructor(message) {
    super(String(message).slice(0, 300));
    this.name = 'FinishError';
  }
}
