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
  const micSelect      = document.getElementById('mic-select');
  const saveBtn        = document.getElementById('save-btn');
  const saveModal      = document.getElementById('save-modal');
  const saveFilename   = document.getElementById('save-filename');
  const saveCancelBtn  = document.getElementById('save-cancel-btn');
  const saveConfirmBtn = document.getElementById('save-confirm-btn');

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

      micStream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true }, video: false });

      recorder = new MultiTrackRecorder(audioCtx, micStream);
      recorder.onTrackAdded   = renderTrack;
      recorder.onTrackRemoved = (t) => {
        var el = document.getElementById('track-' + t.id);
        if (el) el.parentNode.removeChild(el);
        updateTrackListVisibility();
        updatePlaybackButtons();
      };
      recorder.onPlaybackEnd = () => setState('ready');

      initScreen.classList.add('hidden');
      controls.classList.remove('hidden');

      // Enumerate devices now that permission is granted — labels are only
      // available after the first getUserMedia call resolves.
      await populateMicSelector();

      setState('ready');
    } catch (err) {
      alert('Could not access microphone: ' + err.message);
    }
  });

  // ── Mic selector ──────────────────────────────────────────
  async function populateMicSelector() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      console.warn('enumerateDevices failed:', err);
    }

    const inputs = devices.filter(d => d.kind === 'audioinput');
    console.log('Audio input devices found:', inputs.length, inputs);

    const currentTrack = micStream.getAudioTracks()[0];
    const currentLabel = currentTrack ? currentTrack.label || '' : '';
    let currentDeviceId = '';
    if (currentTrack && typeof currentTrack.getSettings === 'function') {
      currentDeviceId = currentTrack.getSettings().deviceId || '';
    }

    micSelect.innerHTML = '';

    if (inputs.length === 0) {
      // Fallback: show the active track as a single non-switchable option.
      const opt = document.createElement('option');
      opt.value = currentDeviceId;
      opt.textContent = currentLabel || 'Default Microphone';
      micSelect.appendChild(opt);
      console.warn('No audioinput devices enumerated — showing active track as fallback.');
      return;
    }

    // Filter out the "default" virtual device that some browsers expose —
    // it's a duplicate alias and confuses the list.
    const deduped = inputs.filter(d => d.deviceId !== 'default' && d.deviceId !== '');
    const list = deduped.length > 0 ? deduped : inputs;

    list.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${i + 1}`;

      // Mark selected if deviceId or label matches the active stream track.
      const matchById    = currentDeviceId && device.deviceId === currentDeviceId;
      const matchByLabel = currentLabel && device.label === currentLabel;
      if (matchById || matchByLabel) opt.selected = true;

      micSelect.appendChild(opt);
    });
  }

  // Re-populate when devices are plugged/unplugged (e.g. headphones connected).
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (appState !== 'recording' && appState !== 'calibrating') {
      populateMicSelector();
    }
  });

  micSelect.addEventListener('change', async () => {
    if (appState === 'recording' || appState === 'calibrating') return;

    const deviceId = micSelect.value;
    if (!deviceId) return;

    try {
      // Stop old stream tracks before opening a new one.
      micStream.getTracks().forEach(t => t.stop());
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });
      recorder.micStream = micStream;
    } catch (err) {
      alert('Could not switch microphone: ' + err.message);
      await populateMicSelector();
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
      // Stop recording — also stop the looping backing tracks.
      // Pass silent=true so onPlaybackEnd doesn't clobber the recording state.
      recorder.stopPlayback(true);

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
      // Start recording. If tracks already exist, loop them so the
      // performer hears the backing layers while recording.
      if (recorder.tracks.length > 0) {
        recorder.playAllLooping();
      }
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
    li.id = 'track-' + track.id;

    // ── Top row (always visible) ───────────────────────────
    const row = document.createElement('div');
    row.className = 'track-row';

    const label = document.createElement('span');
    label.className = 'track-label';
    label.textContent = 'Track ' + track.id;

    const dur = document.createElement('span');
    dur.className = 'track-duration';
    dur.textContent = formatDuration(track.duration);

    // Small inline badge showing delay when collapsed
    const delayBadge = document.createElement('span');
    delayBadge.className = 'delay-badge-inline';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'track-btn mute-btn';
    muteBtn.textContent = 'Mute';
    muteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
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
    delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (appState === 'playing') recorder.stopPlayback();
      recorder.deleteTrack(track.id);
    });

    const expandBtn = document.createElement('button');
    expandBtn.className = 'track-expand-btn';
    expandBtn.textContent = '▾';
    expandBtn.setAttribute('aria-label', 'Toggle delay control');

    row.append(label, dur, delayBadge, muteBtn, delBtn, expandBtn);

    // ── Detail panel (expandable) ──────────────────────────
    const detail = document.createElement('div');
    detail.className = 'track-detail hidden';
    detail.appendChild(createDial(track, function(newDelayMs) {
      // Update the inline badge when the dial changes
      if (newDelayMs === 0) {
        delayBadge.textContent = '';
        delayBadge.classList.remove('visible');
      } else {
        delayBadge.textContent = (newDelayMs > 0 ? '+' : '') + newDelayMs + ' ms';
        delayBadge.classList.add('visible');
      }
    }));

    // Toggle expand on row click
    row.addEventListener('click', function() {
      const isExpanded = li.classList.toggle('expanded');
      detail.classList.toggle('hidden', !isExpanded);
    });

    li.append(row, detail);
    tracksEl.appendChild(li);
    updateTrackListVisibility();
    updatePlaybackButtons();
  }

  // ── Rotary dial ───────────────────────────────────────────
  function createDial(track, onChange) {
    var MIN_DELAY = -500;
    var MAX_DELAY = 500;
    var RANGE_DEG = 270;

    // Guard against cached recorder.js that predates the delayMs property.
    if (typeof track.delayMs !== 'number' || isNaN(track.delayMs)) {
      track.delayMs = 0;
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'delay-control';

    var dialLabel = document.createElement('div');
    dialLabel.className = 'delay-label';
    dialLabel.textContent = 'Delay';

    var readout = document.createElement('div');
    readout.className = 'delay-readout';

    var dial = document.createElement('div');
    dial.className = 'dial';

    var indicator = document.createElement('div');
    indicator.className = 'dial-indicator';
    dial.appendChild(indicator);

    function clamp(v) {
      return Math.max(MIN_DELAY, Math.min(MAX_DELAY, v));
    }

    function valueToAngle(ms) {
      var pct = (ms - MIN_DELAY) / (MAX_DELAY - MIN_DELAY);
      return -RANGE_DEG / 2 + pct * RANGE_DEG;
    }

    function updateDisplay() {
      var ms = track.delayMs;
      dial.style.transform = 'rotate(' + valueToAngle(ms) + 'deg)';
      readout.textContent = (ms > 0 ? '+' : '') + ms + ' ms';
      if (onChange) onChange(ms);
    }

    // Scroll wheel — 1 ms per notch, 10 ms with Shift
    dial.addEventListener('wheel', function(e) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1;
      track.delayMs = clamp(track.delayMs + (e.deltaY > 0 ? step : -step));
      updateDisplay();
    });

    // Mouse drag — drag up to increase, drag down to decrease
    dial.addEventListener('mousedown', function(e) {
      var startY = e.clientY;
      var startDelay = track.delayMs;
      e.preventDefault();

      function onMove(ev) {
        track.delayMs = clamp(startDelay + Math.round((startY - ev.clientY) * 2));
        updateDisplay();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Touch drag
    dial.addEventListener('touchstart', function(e) {
      var startY = e.touches[0].clientY;
      var startDelay = track.delayMs;
      e.preventDefault();

      function onMove(ev) {
        track.delayMs = clamp(startDelay + Math.round((startY - ev.touches[0].clientY) * 2));
        updateDisplay();
        ev.preventDefault();
      }
      function onEnd() {
        dial.removeEventListener('touchmove', onMove);
        dial.removeEventListener('touchend', onEnd);
      }
      dial.addEventListener('touchmove', onMove, { passive: false });
      dial.addEventListener('touchend', onEnd);
    }, { passive: false });

    updateDisplay();
    wrapper.append(dialLabel, readout, dial);
    return wrapper;
  }

  function updateTrackListVisibility() {
    const hasTracks = recorder.tracks.length > 0;
    trackList.classList.toggle('hidden', !hasTracks);
    saveBtn.classList.toggle('hidden', !hasTracks);
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
        micSelect.disabled = false;
        updatePlaybackButtons();
        break;
      case 'calibrating':
        stateLabel.textContent = 'Calibrating';
        stateLabel.className = 'calib';
        recordBtn.disabled = true;
        playBtn.disabled   = true;
        stopBtn.disabled   = true;
        micSelect.disabled = true;
        break;
      case 'recording':
        stateLabel.textContent = 'Recording';
        stateLabel.className = 'active';
        recordBtn.querySelector('.btn-label').textContent = 'Stop Rec';
        recordBtn.classList.add('recording');
        playBtn.disabled   = true;
        stopBtn.disabled   = false;
        micSelect.disabled = true;
        break;
      case 'playing':
        stateLabel.textContent = 'Playing';
        stateLabel.className = 'playing';
        recordBtn.disabled = true;
        playBtn.disabled   = true;
        stopBtn.disabled   = false;
        micSelect.disabled = false;
        break;
    }
  }

  // ── Save modal ────────────────────────────────────────────
  saveBtn.addEventListener('click', function() {
    var unmuted = recorder.tracks.filter(function(t) { return !t.muted; });
    if (unmuted.length === 0) { alert('No unmuted tracks to save.'); return; }
    saveFilename.value = '';
    saveModal.classList.remove('hidden');
    saveFilename.focus();
  });

  saveCancelBtn.addEventListener('click', function() {
    saveModal.classList.add('hidden');
  });

  // Close on backdrop click
  saveModal.addEventListener('click', function(e) {
    if (e.target === saveModal) saveModal.classList.add('hidden');
  });

  // Allow Enter key to confirm
  saveFilename.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') saveConfirmBtn.click();
    if (e.key === 'Escape') saveModal.classList.add('hidden');
  });

  saveConfirmBtn.addEventListener('click', function() {
    var rawName = saveFilename.value.trim();
    // Fall back to a default if the field is empty; strip characters
    // that are illegal in filenames on common operating systems.
    var safeName = (rawName || 'looper-mix').replace(/[/\\?%*:|"<>]/g, '-');
    var filename = safeName + '.wav';

    var unmuted = recorder.tracks.filter(function(t) { return !t.muted; });
    var sampleRate = audioCtx.sampleRate;
    var minDelay = unmuted.reduce(function(min, t) { return Math.min(min, t.delayMs || 0); }, 0);

    var totalSamples = 0;
    unmuted.forEach(function(track) {
      var startSample = Math.round(((track.delayMs || 0) - minDelay) / 1000 * sampleRate);
      totalSamples = Math.max(totalSamples, startSample + track.buffer.length);
    });

    var mix = new Float32Array(totalSamples);
    unmuted.forEach(function(track) {
      var startSample = Math.round(((track.delayMs || 0) - minDelay) / 1000 * sampleRate);
      var src = track.buffer.getChannelData(0);
      for (var i = 0; i < src.length; i++) {
        mix[startSample + i] += src[i];
      }
    });

    for (var i = 0; i < mix.length; i++) {
      mix[i] = Math.max(-1, Math.min(1, mix[i]));
    }

    var wav = encodeWAV(mix, sampleRate);
    var url = URL.createObjectURL(wav);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    saveModal.classList.add('hidden');
  });

  function encodeWAV(samples, sampleRate) {
    var numChannels = 1;
    var bitsPerSample = 16;
    var blockAlign = numChannels * (bitsPerSample / 8);
    var byteRate = sampleRate * blockAlign;
    var dataSize = samples.length * blockAlign;
    var buf = new ArrayBuffer(44 + dataSize);
    var v = new DataView(buf);

    function str(offset, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
    }

    str(0,  'RIFF');
    v.setUint32(4,  36 + dataSize, true);
    str(8,  'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);           // PCM chunk size
    v.setUint16(20, 1,  true);           // PCM format
    v.setUint16(22, numChannels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    str(36, 'data');
    v.setUint32(40, dataSize, true);

    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([buf], { type: 'audio/wav' });
  }

  // ── Utilities ─────────────────────────────────────────────
  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(1).padStart(4, '0');
    return m > 0 ? `${m}:${s}` : `${s}s`;
  }
})();
