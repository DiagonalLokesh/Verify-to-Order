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
            // Scale down very large images to speed up jsQR processing
            const MAX = 1600;
            const scale = img.width > MAX || img.height > MAX
              ? MAX / Math.max(img.width, img.height) : 1;

            canvasEl.width  = Math.round(img.width  * scale);
            canvasEl.height = Math.round(img.height * scale);
            ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);

            const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
            emit('info', 'Scanning for QR code…');

            // Try normal then inverted — handles both light-on-dark and dark-on-light QRs
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

    /** No-op stub kept so any lingering calls don't throw */
    stop() {},
  };

})();
