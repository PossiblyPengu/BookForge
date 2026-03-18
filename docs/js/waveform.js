/**
 * waveform.js
 *
 * Generates mini waveform visualizations for audio files using Web Audio API.
 * Renders to a canvas element for lightweight display in track rows.
 */

const CANVAS_WIDTH = 200;
const CANVAS_HEIGHT = 32;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const NUM_BARS = Math.floor(CANVAS_WIDTH / (BAR_WIDTH + BAR_GAP));

/**
 * Decode an audio file and extract peak amplitude data.
 * @param {File|Blob} file
 * @returns {Promise<Float32Array>} Normalized peak values (0-1)
 */
const extractPeaks = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new OfflineAudioContext(1, 1, 44100);
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    // Release audio context resources immediately
    await audioCtx.startRendering().catch(() => {});
    if (typeof audioCtx.close === "function") {
      await audioCtx.close().catch(() => {});
    }
  }
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / NUM_BARS);
  const peaks = new Float32Array(NUM_BARS);

  for (let i = 0; i < NUM_BARS; i++) {
    let max = 0;
    const start = i * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }

  return peaks;
};

/**
 * Render peaks data onto a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array} peaks
 * @param {string} [color="#f0a040"]
 */
const renderPeaks = (canvas, peaks, color = "#f0a040") => {
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = color;

  const mid = CANVAS_HEIGHT / 2;
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * (CANVAS_HEIGHT - 2));
    const x = i * (BAR_WIDTH + BAR_GAP);
    ctx.fillRect(x, mid - h / 2, BAR_WIDTH, h);
  }
};

/**
 * Generate and render a waveform for a file.
 * Returns the canvas element.
 * @param {File|Blob} file
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export const createWaveform = async (file) => {
  try {
    const peaks = await extractPeaks(file);
    const canvas = document.createElement("canvas");
    canvas.className = "track-waveform";
    // Read accent color from CSS custom property
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f0a040";
    renderPeaks(canvas, peaks, accent);
    return canvas;
  } catch {
    return null;
  }
};
