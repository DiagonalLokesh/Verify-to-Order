/**
 * Scanner Module — Gallery upload + Live Camera scanning
 *
 * Depends on:
 *   - jsQR  (window.jsQR)
 *   - pako  (window.pako)  — for new Aadhaar format decompression
 *   - AadhaarParser (./aadhaar.js)
 *   - Tesseract.js (lazily loaded for OCR fallback in camera mode)
 */

const Scanner = (() => {

  /* ---- Callbacks ---- */
  let onResultCb   = null;
  let onErrorCb    = null;
  let onStatusCb   = null;
  let onGuidanceCb = null;

  /* ---- Shared DOM ---- */
  let canvasEl = null;
  let ctx      = null;

  /* ---- Camera state ---- */
  let videoEl          = null;
  let cameraStream     = null;
  let cameraActive     = false;
  let scanLoopId       = null;
  let zoomLevel        = 1;
  let zoomMin          = 1;
  let zoomMax          = 3;
  let zoomTrack        = null;
  let frameCount       = 0;
  let lastGuidanceText = '';
  let ocrTimer         = null;
  let ocrRunning       = false;
  let tesseractWorker  = null;

  /* ------------------------------------------------------------------ */

  function emit(type, message) {
    if (onStatusCb) onStatusCb({ type, message });
  }

  function emitGuidance(text) {
    if (text !== lastGuidanceText) {
      lastGuidanceText = text;
      if (onGuidanceCb) onGuidanceCb(text);
    }
  }

  /** Parse raw QR text and fire result/error callback */
  async function handleQRData(qrText) {
    emit('info', 'QR code detected — verifying…');
    try {
      const result = await AadhaarParser.parse(qrText);

      if (result.format === 'aadhaar-number') {
        if (onErrorCb) onErrorCb(new Error('AADHAAR_NUMBER_ONLY'), qrText);
        return;
      }
      if (result.age === null) {
        if (onErrorCb) onErrorCb(new Error('Could not extract date of birth from this QR code.'), qrText);
        return;
      }
      if (onResultCb) onResultCb(result);

    } catch (err) {
      if (onErrorCb) onErrorCb(err, qrText);
    }
  }

  /* -------- Camera guidance heuristic -------- */
  /* Shows guidance only when a card-like object (significant edge density) is present */
  function _analyzeFrame(imageData, w, h) {
    const data = imageData.data;
    const cx   = Math.floor(w / 2);
    const cy   = Math.floor(h / 2);
    const rx   = Math.floor(w * 0.38);
    const ry   = Math.floor(h * 0.32);
    const step = 6; // larger step = faster on mobile

    let edgeCount  = 0;
    let brightness = 0;
    let samples    = 0;

    for (let y = cy - ry; y < cy + ry; y += step) {
      for (let x = cx - rx; x < cx + rx; x += step) {
        const i  = (y * w + x) * 4;
        const i1 = (y * w + (x + step)) * 4;
        const i2 = ((y + step) * w + x) * 4;
        if (i2 + 2 >= data.length) continue;

        const r = data[i], g = data[i + 1], b = data[i + 2];
        brightness += (r + g + b) / 3;
        samples++;

        const gx = Math.abs(r - data[i1]) + Math.abs(g - data[i1 + 1]) + Math.abs(b - data[i1 + 2]);
        const gy = Math.abs(r - data[i2]) + Math.abs(g - data[i2 + 1]) + Math.abs(b - data[i2 + 2]);
        if ((gx + gy) / 3 > 25) edgeCount++;
      }
    }

    if (!samples) return '';

    const avgBrightness = brightness / samples;
    const edgeDensity   = edgeCount / samples;

    // Low edge density = no card present → suppress guidance
    if (edgeDensity < 0.04) return '';

    if (avgBrightness < 55) return 'Improve lighting';
    if (edgeDensity > 0.45) return 'Move farther';
    if (edgeDensity < 0.08) return 'Move closer';
    if (edgeDensity < 0.12) return 'Center Aadhaar card';

    return 'Stay still';
  }

  /* -------- Camera scan loop -------- */
  function _scanLoop() {
    if (!cameraActive) return;

    frameCount++;

    // Process every 3rd frame (~20fps equivalent) — reduces CPU load on mobile
    if (frameCount % 3 === 0 && videoEl && videoEl.readyState >= 2) {
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;

      if (w && h) {
        // Only resize canvas when video dimensions change
        if (canvasEl.width !== w || canvasEl.height !== h) {
          canvasEl.width  = w;
          canvasEl.height = h;
        }
        ctx.drawImage(videoEl, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);

        // attemptBoth replaces calling jsQR twice — faster on mobile
        const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });

        if (code?.data) {
          cameraActive = false;
          cancelAnimationFrame(scanLoopId);
          _clearOcrTimer();
          emitGuidance('');
          handleQRData(code.data);
          return;
        }

        // Guidance update every ~3 s (every 60 processed frames at ~20fps)
        if (frameCount % 180 === 0) {
          emitGuidance(_analyzeFrame(imageData, w, h));
        }
      }
    }

    scanLoopId = requestAnimationFrame(_scanLoop);
  }

  /* -------- OCR fallback (Tesseract.js, lazily loaded) -------- */
  function _clearOcrTimer() {
    if (ocrTimer) { clearTimeout(ocrTimer); ocrTimer = null; }
  }

  async function _loadAndStartOCR() {
    if (!cameraActive || tesseractWorker) return;
    try {
      if (!window.Tesseract) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      tesseractWorker = await Tesseract.createWorker('eng');
      await tesseractWorker.setParameters({ tessedit_char_whitelist: '0123456789 ' });
      _runOCR();
    } catch {
      // OCR unavailable — continue with QR-only scanning
    }
  }

  async function _runOCR() {
    if (!cameraActive || !tesseractWorker || ocrRunning) return;
    ocrRunning = true;
    try {
      if (videoEl?.readyState >= 2) {
        const w = videoEl.videoWidth;
        const h = videoEl.videoHeight;
        if (canvasEl.width !== w || canvasEl.height !== h) {
          canvasEl.width = w; canvasEl.height = h;
        }
        ctx.drawImage(videoEl, 0, 0, w, h);

        const { data: { text } } = await tesseractWorker.recognize(canvasEl);
        const m = text.replace(/\s+/g, ' ').match(/\b(\d{4}[ -]?\d{4}[ -]?\d{4})\b/);
        if (m) {
          const num = m[1].replace(/[\s-]/g, '');
          if (cameraActive && /^\d{12}$/.test(num)) {
            cameraActive = false;
            cancelAnimationFrame(scanLoopId);
            emitGuidance('');
            if (onErrorCb) onErrorCb(new Error('AADHAAR_NUMBER_ONLY'), num);
            return;
          }
        }
      }
    } catch { /* ignore per-frame OCR errors */ }
    ocrRunning = false;
    if (cameraActive) ocrTimer = setTimeout(_runOCR, 2500);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */
  return {

    /** Initialize for gallery mode. Call before scanImage(). */
    init({ canvas, onResult, onError, onStatus }) {
      canvasEl   = canvas;
      ctx        = canvas.getContext('2d', { willReadFrequently: true });
      onResultCb = onResult;
      onErrorCb  = onError;
      onStatusCb = onStatus;
    },

    /** Scan a File/Blob for a QR code (gallery mode). */
    scanImage(file) {
      emit('info', 'Reading image…');
      return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
          const err = new Error('Please select a valid image file (JPG, PNG, WebP).');
          emit('error', err.message);
          if (onErrorCb) onErrorCb(err, '');
          return reject(err);
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const MAX   = 1600;
            const scale = img.width > MAX || img.height > MAX
              ? MAX / Math.max(img.width, img.height) : 1;

            canvasEl.width  = Math.round(img.width  * scale);
            canvasEl.height = Math.round(img.height * scale);
            ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);

            const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
            emit('info', 'Scanning for QR code…');

            let code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
            if (!code) code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'onlyInvert' });

            if (!code || !code.data) {
              const err = new Error('No QR code found in the image. Try a clearer photo with good lighting.');
              emit('error', err.message);
              if (onErrorCb) onErrorCb(err, '');
              return reject(err);
            }
            emit('success', 'QR code found!');
            handleQRData(code.data).then(resolve).catch(reject);
          };
          img.onerror = () => {
            const err = new Error('Could not load the image. Please try a different file.');
            emit('error', err.message);
            if (onErrorCb) onErrorCb(err, '');
            reject(err);
          };
          img.src = e.target.result;
        };
        reader.onerror = () => {
          const err = new Error('Failed to read the file.');
          if (onErrorCb) onErrorCb(err, '');
          reject(err);
        };
        reader.readAsDataURL(file);
      });
    },

    /**
     * Start live camera scanning.
     * Throws DOMException if camera permission is denied or unavailable.
     */
    async startCamera({ video, canvas, onResult, onError, onStatus, onGuidance }) {
      videoEl      = video;
      canvasEl     = canvas;
      ctx          = canvas.getContext('2d', { willReadFrequently: true });
      onResultCb   = onResult;
      onErrorCb    = onError;
      onStatusCb   = onStatus;
      onGuidanceCb = onGuidance;

      // navigator.mediaDevices is undefined on plain HTTP (non-localhost)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('Camera requires a secure connection (HTTPS).'), { name: 'NotSupportedError' });
      }

      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      // Probe native zoom capability
      zoomTrack = cameraStream.getVideoTracks()[0];
      try {
        const caps = zoomTrack.getCapabilities?.();
        if (caps?.zoom) {
          zoomMin   = caps.zoom.min;
          zoomMax   = caps.zoom.max;
          zoomLevel = caps.zoom.min;
        } else {
          zoomMin = 1; zoomMax = 3; zoomLevel = 1;
        }
      } catch {
        zoomMin = 1; zoomMax = 3; zoomLevel = 1;
      }

      cameraActive     = true;
      frameCount       = 0;
      lastGuidanceText = '';

      videoEl.srcObject = cameraStream;

      // Start scan loop only after the video is actually playing.
      // DO NOT await play() — on iOS it races with autoplay and throws AbortError.
      const onPlaying = () => {
        if (!cameraActive) return;
        _scanLoop();
        _clearOcrTimer();
        ocrTimer = setTimeout(() => _loadAndStartOCR(), 6000);
      };
      videoEl.addEventListener('playing', onPlaying, { once: true });

      // Explicit play() call needed on some Android browsers even with autoplay attr.
      // Errors here are non-fatal: autoplay handles it, AbortError is expected.
      videoEl.play().catch(err => {
        if (err.name === 'AbortError') return;
        // Real error — clean up
        videoEl.removeEventListener('playing', onPlaying);
        cameraActive = false;
        if (onErrorCb) onErrorCb(err, '');
      });
    },

    /** Stop camera stream and release all resources. */
    stopCamera() {
      cameraActive = false;
      if (scanLoopId)      { cancelAnimationFrame(scanLoopId); scanLoopId = null; }
      _clearOcrTimer();
      if (cameraStream)    { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
      if (videoEl)         { videoEl.srcObject = null; videoEl = null; }
      if (tesseractWorker) { tesseractWorker.terminate(); tesseractWorker = null; }
      ocrRunning       = false;
      frameCount       = 0;
      lastGuidanceText = '';
      zoomLevel        = 1;
    },

    /**
     * Adjust zoom by delta (+0.5 or -0.5).
     * Uses native camera zoom when supported, CSS transform otherwise.
     * Returns display zoom value (always 1.0–3.0 range) for label.
     */
    adjustZoom(delta) {
      const caps = zoomTrack?.getCapabilities?.();
      if (caps?.zoom) {
        const step = Math.max(0.1, (caps.zoom.max - caps.zoom.min) / 6);
        zoomLevel = Math.max(caps.zoom.min, Math.min(caps.zoom.max, zoomLevel + delta * step));
        zoomTrack.applyConstraints({ advanced: [{ zoom: zoomLevel }] }).catch(() => {});
        // Normalise to 1x–3x for display
        const range = caps.zoom.max - caps.zoom.min || 1;
        return 1 + ((zoomLevel - caps.zoom.min) / range) * 2;
      }
      // CSS scale fallback — only scales the video element, container stays fixed
      zoomLevel = Math.max(1, Math.min(3, zoomLevel + delta));
      if (videoEl) videoEl.style.transform = `scale(${zoomLevel})`;
      return zoomLevel;
    },

    getZoom() { return zoomLevel; },

    /** No-op stub — kept so lingering calls don't throw */
    stop() {},
  };

})();
