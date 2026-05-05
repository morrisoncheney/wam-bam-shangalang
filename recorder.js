/**
 * recorder.js
 * Manages multi-track audio recording and playback.
 *
 * Recording pipeline:
 *   MediaRecorder → Blob → ArrayBuffer → AudioBuffer → trim(latencyOffset)
 *
 * Playback pipeline:
 *   AudioBuffer → AudioBufferSourceNode → AudioContext.destination
 *   All unmuted tracks are started simultaneously via a shared start time.
 */

class Track {
  constructor(id, audioBuffer, sampleRate) {
    this.id = id;
    this.buffer = audioBuffer;
    this.sampleRate = sampleRate;
    this.muted = false;
    this.duration = audioBuffer.duration; // seconds
  }
}

class MultiTrackRecorder {
  /**
   * @param {AudioContext} ctx
   * @param {MediaStream} micStream
   */
  constructor(ctx, micStream) {
    this.ctx = ctx;
    this.micStream = micStream;
    this.tracks = [];
    this._nextId = 1;
    this._mediaRecorder = null;
    this._chunks = [];
    this._isRecording = false;
    this._activeSources = []; // currently playing AudioBufferSourceNodes
    this._isPlaying = false;
    this.latencyOffsetMs = 0;

    // Callbacks — set by caller
    this.onTrackAdded = null;
    this.onTrackRemoved = null;
    this.onPlaybackEnd = null;
  }

  get isRecording() { return this._isRecording; }
  get isPlaying()   { return this._isPlaying; }

  // ── Recording ─────────────────────────────────────────────

  startRecording() {
    if (this._isRecording) return;

    this._chunks = [];

    // Prefer audio/webm; fall back gracefully.
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''; // browser picks default

    const options = mimeType ? { mimeType } : {};
    this._mediaRecorder = new MediaRecorder(this.micStream, options);

    this._mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };

    this._mediaRecorder.start(100); // collect in 100 ms chunks
    this._isRecording = true;
  }

  /** Returns a Promise<Track> that resolves when the buffer is decoded and trimmed. */
  stopRecording() {
    if (!this._isRecording) return Promise.reject(new Error('Not recording'));

    return new Promise((resolve, reject) => {
      this._mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this._chunks, { type: this._mediaRecorder.mimeType || 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          const rawBuffer = await this.ctx.decodeAudioData(arrayBuffer);
          const trimmed = this._trimBuffer(rawBuffer, this.latencyOffsetMs);
          const track = new Track(this._nextId++, trimmed, this.ctx.sampleRate);
          this.tracks.push(track);
          this.onTrackAdded && this.onTrackAdded(track);
          resolve(track);
        } catch (err) {
          reject(err);
        }
      };

      this._mediaRecorder.stop();
      this._isRecording = false;
    });
  }

  // ── Playback ──────────────────────────────────────────────

  playAll() {
    if (this._isPlaying) this.stopPlayback();

    const unmuted = this.tracks.filter(t => !t.muted);
    if (unmuted.length === 0) return;

    // Schedule all tracks to start slightly in the future so they're truly simultaneous.
    const startTime = this.ctx.currentTime + 0.05;
    let endTime = startTime;
    this._activeSources = [];

    unmuted.forEach(track => {
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(this.ctx.destination);
      src.start(startTime);
      this._activeSources.push(src);
      endTime = Math.max(endTime, startTime + track.duration);
    });

    this._isPlaying = true;

    // Fire onPlaybackEnd when the longest track finishes.
    const playDurationMs = (endTime - this.ctx.currentTime) * 1000;
    this._playbackTimer = setTimeout(() => {
      this._isPlaying = false;
      this._activeSources = [];
      this.onPlaybackEnd && this.onPlaybackEnd();
    }, playDurationMs + 200);
  }

  stopPlayback() {
    clearTimeout(this._playbackTimer);
    this._activeSources.forEach(src => {
      try { src.stop(); } catch (_) {}
    });
    this._activeSources = [];
    this._isPlaying = false;
    this.onPlaybackEnd && this.onPlaybackEnd();
  }

  // ── Track management ──────────────────────────────────────

  muteTrack(id) {
    const track = this.tracks.find(t => t.id === id);
    if (track) track.muted = !track.muted;
    return track;
  }

  deleteTrack(id) {
    const idx = this.tracks.findIndex(t => t.id === id);
    if (idx !== -1) {
      const [removed] = this.tracks.splice(idx, 1);
      this.onTrackRemoved && this.onTrackRemoved(removed);
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * Trim the first `offsetMs` milliseconds from an AudioBuffer.
   * Returns a new AudioBuffer with trimmed content.
   */
  _trimBuffer(buffer, offsetMs) {
    const ctx = this.ctx;
    const offsetSamples = Math.floor((offsetMs / 1000) * buffer.sampleRate);
    const trimStart = Math.min(offsetSamples, buffer.length - 1);
    const newLength = Math.max(1, buffer.length - trimStart);

    const out = ctx.createBuffer(buffer.numberOfChannels, newLength, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const srcData = buffer.getChannelData(ch);
      const dstData = out.getChannelData(ch);
      dstData.set(srcData.subarray(trimStart, trimStart + newLength));
    }
    return out;
  }
}
