/**
 * Scanner Module — Gallery / image upload only
 *
 * Depends on:
 *   - jsQR  (window.jsQR)
 *   - pako  (window.pako)  — for new Aadhaar format decompression
 *   - AadhaarParser (./aadhaar.js)
 */

const Scanner = (() => {

  /* ---- Callbacks (set via init) ---- */
  let onResultCb = null;
  let onErrorCb  = null;
  let onStatusCb = null;

  /* ---- DOM refs ---- */
  let canvasEl = null;
  let ctx      = null;

  /* ------------------------------------------------------------------ */

  function emit(type, message) {
    if (onStatusCb) onStatusCb({ type, message });
  }

  /** Parse a raw QR string through AadhaarParser and fire the appropriate callback */
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

  /**
   * Try jsQR on a canvas at a given scale of img.
   * Returns a jsQR result object or null.
   */
  function _tryScan(img, scale) {
    const w = Math.round(img.width  * scale);
    const h = Math.round(img.height * scale);
    canvasEl.width  = w;
    canvasEl.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    let code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' });
    if (!code) code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'onlyInvert' });
    return code || null;
  }

  /**
   * Scan each of the 4 quadrants at an enlarged size.
   * Effective for photos where the Aadhaar card/QR is small in the corner.
   */
  function _scanQuadrants(img) {
    const tempCanvas = document.createElement('canvas');
    const tempCtx    = tempCanvas.getContext('2d', { willReadFrequently: true });
    const QUAD_RENDER = 1400; // render each half-slice at this dimension

    // Try halves first (better coverage), then quadrants
    const slices = [
      // top-half, bottom-half, left-half, right-half
      { sx: 0,             sy: 0,              sw: img.width,   sh: img.height / 2 },
      { sx: 0,             sy: img.height / 2, sw: img.width,   sh: img.height / 2 },
      { sx: 0,             sy: 0,              sw: img.width / 2, sh: img.height   },
      { sx: img.width / 2, sy: 0,              sw: img.width / 2, sh: img.height   },
      // quadrants
      { sx: 0,             sy: 0,              sw: img.width / 2, sh: img.height / 2 },
      { sx: img.width / 2, sy: 0,              sw: img.width / 2, sh: img.height / 2 },
      { sx: 0,             sy: img.height / 2, sw: img.width / 2, sh: img.height / 2 },
      { sx: img.width / 2, sy: img.height / 2, sw: img.width / 2, sh: img.height / 2 },
    ];

    for (const q of slices) {
      const scale = QUAD_RENDER / Math.max(q.sw, q.sh);
      tempCanvas.width  = Math.round(q.sw * scale);
      tempCanvas.height = Math.round(q.sh * scale);
      tempCtx.drawImage(img, q.sx, q.sy, q.sw, q.sh, 0, 0, tempCanvas.width, tempCanvas.height);
      const data = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      let code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' });
      if (!code) code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'onlyInvert' });
      if (code?.data) return code;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */
  return {

    /**
     * Initialize with DOM elements and callbacks.
     * Call once before scanImage.
     */
    init({ canvas, onResult, onError, onStatus }) {
      canvasEl   = canvas;
      ctx        = canvas.getContext('2d', { willReadFrequently: true });
      onResultCb = onResult;
      onErrorCb  = onError;
      onStatusCb = onStatus;
    },

    /**
     * Scan a File or Blob for a QR code.
     * Multi-scale strategy ensures small QR codes inside larger photos are detected.
     * Results and errors are delivered via the callbacks passed to init().
     */
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
            emit('info', 'Scanning for QR code…');

            const naturalMax = Math.max(img.width, img.height);

            /*
             * Multi-scale scan strategy (small-QR-in-large-photo problem):
             *  1. Full resolution up to 3000px — best for QR-only screenshots
             *  2. 1600px cap — fast baseline
             *  3. 2× upscale (cap 3200px) — boosts tiny QRs to detectable pixel density
             *  4. 3× upscale (cap 4000px) — very small QR codes
             *  5. Quadrant + half-image scan — QR is in one area of a wide photo
             */
            const scaleAttempts = [
              Math.min(1.0,  3000 / naturalMax),  // 1. natural/near-natural
              Math.min(1.0,  1600 / naturalMax),  // 2. 1600px baseline
              Math.min(2.0,  3200 / naturalMax),  // 3. 2× upscale
              Math.min(3.0,  4000 / naturalMax),  // 4. 3× upscale
            ];

            // Deduplicate very similar scales to avoid redundant passes
            const tried = new Set();
            let code = null;

            for (const rawScale of scaleAttempts) {
              const scale = Math.round(rawScale * 100) / 100;
              if (tried.has(scale)) continue;
              tried.add(scale);

              code = _tryScan(img, scale);
              if (code?.data) break;
            }

            // 5. Region scan — effective when Aadhaar card is small inside a full photo
            if (!code?.data) {
              code = _scanQuadrants(img);
            }

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

    /** No-op stub kept so any lingering calls don't throw */
    stop() {},
  };

})();
