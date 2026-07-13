/**
 * analyze/* index — re-export only. Implementation lives in per-command modules.
 */
export { analyzeLoudness, type AnalyzeLoudnessParams } from "./loudness.ts";
export {
  analyzeWaveform,
  computeWaveform,
  type AnalyzeWaveformParams,
  type WaveformReport,
  type WaveformWindow,
} from "./waveform.ts";
export { analyzeSilence, type AnalyzeSilenceParams, type TimeRange } from "./silence.ts";
export {
  analyzeFrameDiff,
  computeFrameChanges,
  type AnalyzeFrameDiffParams,
  type FrameChangePoint,
} from "./frame-diff.ts";
