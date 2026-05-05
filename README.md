# Looper

A mobile-friendly, latency-compensated audio looper built with vanilla HTML, CSS, and JavaScript. No dependencies.

## Features

- **Latency calibration** — measures round-trip audio delay by playing a click through the speaker and detecting it via the microphone. Runs 5 trials and averages the results.
- **Multi-track recording** — record unlimited layers from the microphone. Each recording is automatically trimmed by the measured latency offset so all tracks align to the true moment sound was produced.
- **Simultaneous playback** — all unmuted tracks start at the same scheduled AudioContext time for sample-accurate layering.
- **Per-track controls** — mute/unmute and delete individual tracks.
- **Dark, touch-friendly UI** — large buttons, clear state labels, designed for mobile use.

## Usage

### Running locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

> **Note:** The app must be served over HTTP — opening `index.html` directly as a `file://` URL will block microphone access.

### Workflow

1. **Start** — tap the Start button to initialize the audio context (required on iOS Safari).
2. **Calibrate** — tap *Calibrate Latency* and keep the room quiet. The app plays a click through the speaker and listens for it on the mic over 5 trials. The resulting offset (in ms) is shown in the header and applied to all future recordings.
3. **Record** — tap *Record* to start, tap *Stop Rec* to finish. The track appears in the list below.
4. **Layer** — repeat step 3 to add more tracks. Each new recording plays back against the previous ones automatically aligned.
5. **Play / Stop** — use the playback controls to audition all unmuted tracks together.

### Calibration tips

- Use **headphones** for best results — this prevents the click from feeding directly back into the mic and skewing the measurement.
- If calibration false-triggers on ambient noise, raise `AMPLITUDE_THRESHOLD` in `calibration.js` (default: `0.08`, range: `0`–`1`).

## File structure

```
index.html        — markup and script loading order
styles.css        — dark theme, layout, animations
calibration.js    — LatencyCalibrator class
recorder.js       — MultiTrackRecorder and Track classes
app.js            — DOM wiring and state machine
```

## Browser support

Requires Web Audio API and MediaRecorder API. Tested on:

- Chrome / Edge (desktop & Android)
- Safari 14.5+ (iOS & macOS) — AudioContext is initialized inside a tap handler to satisfy the user gesture requirement
- Firefox (desktop)
