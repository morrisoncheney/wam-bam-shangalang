/**
 * app.js
 * Wires together the calibration and recorder modules with the DOM.
 */

(function () {
  'use strict';

  // ── DOM refs ───────────────────────────────────────────────
  const initScreen   = document.getElementById('init-screen');
  const initBtn      = document.getElementById('init-btn');
  const controls     = document.getElementById('controls');
  const stateLabel   = document.getElementById('state-label');
  const latencyDisplay = document.getElementById('latency-display');
  const calibrateBtn = document.getElementById('calibrate-btn');
  const calibProgress = document.getElementById('calibration-progress');
  const calibFill    = document.getElementById('calibration-fill');
  const calibStatus  = document.getElementById('calibration-status');
  const recordBtn    = document.getElementById('record-btn');
  const playBtn      = document.getElementById('play-btn');
  const stopBtn      = document.getElementById('stop-btn');
  const trackList    = document.getElementById('track-list');
  const tracksEl     = document.getElementById('tracks');

  // ── State ─────────────────────────────────────────────────
  let audioCtx = null;
  let micStream = null;
  let recorder = null;
  let calibrator = null;
  let latencyOffsetMs = 0;
  let appState = 'idle'; // idle | calibrating | ready | recording | playing

  // ── Init (requires user gesture for iOS) ──────────────────
  initBtn.addEventListener('click', async () => {
    try {
      // AudioContext must be created/resumed inside a user gesture on iOS.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      recorder = new MultiTrackRecorder(audioCtx, micStream);
      recorder.onTrackAdded   = renderTrack;
      recorder.onTrackRemoved = (t) => {
        document.getElementById(`track-${t.id}`)?.remove();
        updateTrackListVisibility();
        updatePlaybackButtons();
      };
      recorder.onPlaybackEnd = () => setState('ready');

      initScreen.classList.add('hidden');
      controls.classList.remove('hidden');
      setState('ready');
    } catch (err) {
      alert('Could not access microphone: ' + err.message);
    }
  });

  // ── Calibration ───────────────────────────────────────────
  calibrateBtn.addEventListener('click', () => {
    if (appState === 'calibrating') return;
    if (appState === 'recording') return;

    setState('calibrating');
    calibProgress.classList.remove('hidden');
    calibrateBtn.disabled = true;

    calibrator = new LatencyCalibrator(audioCtx, micStream, {
      onProgress(trial, total) {
        calibFill.style.width = `${(trial / total) * 100}%`;
        calibStatus.textContent = `Trial ${trial} / ${total}`;
      },
      onComplete(ms) {
        latencyOffsetMs = ms;
        recorder.latencyOffsetMs = ms;
        latencyDisplay.textContent = `${ms.toFixed(1)} ms`;
        latencyDisplay.classList.remove('hidden');
        calibrateBtn.disabled = false;
        calibProgress.classList.add('hidden');
        setState('ready');
      },
      onError(err) {
        alert('Calibration failed: ' + err.message);
        calibrateBtn.disabled = false;
        calibProgress.classList.add('hidden');
        setState('ready');
      },
    });

    calibrator.run();
  });

  // ── Recording ─────────────────────────────────────────────
  recordBtn.addEventListener('click', async () => {
    if (appState === 'playing') recorder.stopPlayback();

    if (appState === 'recording') {
      // Stop recording
      recordBtn.disabled = true;
      recordBtn.querySelector('.btn-label').textContent = 'Saving…';
      recordBtn.classList.remove('recording');

      try {
        await recorder.stopRecording();
      } catch (err) {
        alert('Failed to save recording: ' + err.message);
      }

      recordBtn.disabled = false;
      recordBtn.querySelector('.btn-label').textContent = 'Record';
      setState('ready');
    } else {
      // Start recording
      recorder.startRecording();
      setState('recording');
    }
  });

  // ── Playback ──────────────────────────────────────────────
  playBtn.addEventListener('click', () => {
    if (appState === 'recording') return;
    recorder.playAll();
    setState('playing');
  });

  stopBtn.addEventListener('click', () => {
    if (appState === 'playing') {
      recorder.stopPlayback();
      setState('ready');
    } else if (appState === 'recording') {
      recordBtn.click();
    }
  });

  // ── Track rendering ───────────────────────────────────────
  function renderTrack(track) {
    const li = document.createElement('li');
    li.className = 'track-item';
    li.id = `track-${track.id}`;

    const label = document.createElement('span');
    label.className = 'track-label';
    label.textContent = `Track ${track.id}`;

    const dur = document.createElement('span');
    dur.className = 'track-duration';
    dur.textContent = formatDuration(track.duration);

    const muteBtn = document.createElement('button');
    muteBtn.className = 'track-btn mute-btn';
    muteBtn.textContent = 'Mute';
    muteBtn.addEventListener('click', () => {
      const t = recorder.muteTrack(track.id);
      if (t) {
        muteBtn.textContent = t.muted ? 'Unmute' : 'Mute';
        muteBtn.classList.toggle('muted', t.muted);
        li.style.opacity = t.muted ? '0.5' : '1';
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'track-btn delete-btn';
    delBtn.textContent = 'Del';
    delBtn.addEventListener('click', () => {
      if (appState === 'playing') recorder.stopPlayback();
      recorder.deleteTrack(track.id);
    });

    li.append(label, dur, muteBtn, delBtn);
    tracksEl.appendChild(li);
    updateTrackListVisibility();
    updatePlaybackButtons();
  }

  function updateTrackListVisibility() {
    trackList.classList.toggle('hidden', recorder.tracks.length === 0);
  }

  function updatePlaybackButtons() {
    const hasTracks = recorder.tracks.length > 0;
    playBtn.disabled  = !hasTracks || appState === 'recording';
    stopBtn.disabled  = appState !== 'playing' && appState !== 'recording';
  }

  // ── State machine ─────────────────────────────────────────
  function setState(s) {
    appState = s;
    stateLabel.className = '';

    switch (s) {
      case 'idle':
        stateLabel.textContent = 'Ready';
        break;
      case 'ready':
        stateLabel.textContent = 'Ready';
        recordBtn.disabled = false;
        recordBtn.querySelector('.btn-label').textContent = 'Record';
        recordBtn.classList.remove('recording');
        updatePlaybackButtons();
        break;
      case 'calibrating':
        stateLabel.textContent = 'Calibrating';
        stateLabel.className = 'calib';
        recordBtn.disabled = true;
        playBtn.disabled   = true;
        stopBtn.disabled   = true;
        break;
      case 'recording':
        stateLabel.textContent = 'Recording';
        stateLabel.className = 'active';
        recordBtn.querySelector('.btn-label').textContent = 'Stop Rec';
        recordBtn.classList.add('recording');
        playBtn.disabled = true;
        stopBtn.disabled = false;
        break;
      case 'playing':
        stateLabel.textContent = 'Playing';
        stateLabel.className = 'playing';
        recordBtn.disabled = true;
        playBtn.disabled   = true;
        stopBtn.disabled   = false;
        break;
    }
  }

  // ── Utilities ─────────────────────────────────────────────
  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(1).padStart(4, '0');
    return m > 0 ? `${m}:${s}` : `${s}s`;
  }
})();
