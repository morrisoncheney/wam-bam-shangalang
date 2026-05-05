/**
 * calibration.js
 * Measures round-trip audio latency by playing a click through the speaker
 * and detecting when it returns through the microphone.
 *
 * Algorithm:
 *   1. Schedule a sharp click at a known AudioContext time T_play.
 *   2. Monitor the mic input on an AnalyserNode.
 *   3. When amplitude crosses the threshold, record T_detect (AudioContext.currentTime).
 *   4. latency = (T_detect - T_play) * 1000  [ms]
 *   5. Repeat TRIAL_COUNT times, discard outliers, average.
 */

const TRIAL_COUNT = 5;
const INTER_TRIAL_DELAY_MS = 800; // gap between trials
const DETECT_WINDOW_MS = 2000;    // give up if click not heard within this window
const AMPLITUDE_THRESHOLD = 0.08; // 0–1; tune upward for noisier environments
const CLICK_SCHEDULE_AHEAD_S = 0.1; // schedule click 100 ms ahead of now

class LatencyCalibrator {
  /**
   * @param {AudioContext} ctx
   * @param {MediaStream} micStream
   * @param {function} onProgress  called with (trialIndex, totalTrials)
   * @param {function} onComplete  called with (latencyMs) on success
   * @param {function} onError     called with (Error) on failure
   */
  constructor(ctx, micStream, { onProgress, onComplete, onError } = {}) {
    this.ctx = ctx;
    this.micStream = micStream;
    this.onProgress = onProgress || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});

    this._results = [];
    this._cancelled = false;
  }

  cancel() {
    this._cancelled = true;
    this._teardownMicGraph();
  }

  async run() {
    this._cancelled = false;
    this._results = [];

    try {
      this._buildMicGraph();
    } catch (err) {
      this.onError(err);
      return;
    }

    for (let i = 0; i < TRIAL_COUNT; i++) {
      if (this._cancelled) return;

      this.onProgress(i, TRIAL_COUNT);

      // Brief silence before each trial to let any residual noise settle.
      if (i > 0) await this._sleep(INTER_TRIAL_DELAY_MS);
      if (this._cancelled) return;

      let latency;
      try {
        latency = await this._runTrial();
      } catch (err) {
        // A single failed trial is tolerable; abort only if we can't get enough results.
        console.warn(`Calibration trial ${i + 1} failed:`, err.message);
        if (this._results.length + (TRIAL_COUNT - i - 1) < 3) {
          this._teardownMicGraph();
          this.onError(new Error('Too many failed trials. Ensure headphones are connected or lower ambient noise.'));
          return;
        }
        continue;
      }

      this._results.push(latency);
    }

    this._teardownMicGraph();

    if (this._results.length === 0) {
      this.onError(new Error('No successful calibration trials.'));
      return;
    }

    this.onProgress(TRIAL_COUNT, TRIAL_COUNT);
    const avg = this._trimmedMean(this._results);
    this.onComplete(avg);
  }

  // ── Private ────────────────────────────────────────────────

  _buildMicGraph() {
    const ctx = this.ctx;
    this._micSource = ctx.createMediaStreamSource(this.micStream);
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0;
    this._micSource.connect(this._analyser);
    // Do NOT connect analyser to destination — we don't want mic feedback.
    this._timeDomainBuffer = new Float32Array(this._analyser.fftSize);
  }

  _teardownMicGraph() {
    try { this._micSource && this._micSource.disconnect(); } catch (_) {}
    try { this._analyser && this._analyser.disconnect(); } catch (_) {}
    this._micSource = null;
    this._analyser = null;
  }

  /** Play a click and wait for it to return through the mic. Resolves with ms. */
  _runTrial() {
    return new Promise((resolve, reject) => {
      const ctx = this.ctx;
      const analyser = this._analyser;
      const buf = this._timeDomainBuffer;

      // Build a short impulse: one sample at full amplitude.
      const clickBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.02, ctx.sampleRate);
      const data = clickBuffer.getChannelData(0);
      // Sharp click: fast attack, fast decay envelope over ~20 ms.
      for (let s = 0; s < data.length; s++) {
        const t = s / ctx.sampleRate;
        data[s] = Math.exp(-t * 800) * (s === 0 ? 1 : Math.sin(2 * Math.PI * 1000 * t));
      }

      const source = ctx.createBufferSource();
      source.buffer = clickBuffer;
      source.connect(ctx.destination);

      const scheduleTime = ctx.currentTime + CLICK_SCHEDULE_AHEAD_S;
      source.start(scheduleTime);

      let detected = false;
      let rafId = null;
      const deadline = performance.now() + CLICK_SCHEDULE_AHEAD_S * 1000 + DETECT_WINDOW_MS;

      const poll = () => {
        if (this._cancelled) {
          reject(new Error('Cancelled'));
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error('Click not detected within timeout. Check mic permissions or raise the threshold.'));
          return;
        }

        // Only start listening after click should have been emitted.
        if (ctx.currentTime >= scheduleTime) {
          analyser.getFloatTimeDomainData(buf);
          const peak = buf.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
          if (peak >= AMPLITUDE_THRESHOLD) {
            detected = true;
            const detectTime = ctx.currentTime;
            const latencyMs = Math.max(0, (detectTime - scheduleTime) * 1000);
            resolve(latencyMs);
            return;
          }
        }

        if (!detected) rafId = requestAnimationFrame(poll);
      };

      rafId = requestAnimationFrame(poll);
    });
  }

  /** Average after removing the single highest and lowest values (if ≥ 4 results). */
  _trimmedMean(values) {
    if (values.length < 4) {
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
