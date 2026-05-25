/**
 * Aadhaar QR Parser & Signature Verifier
 *
 * Handles two formats:
 *   OLD: Plain-text XML  <?xml...><PrintLetterBarcodeData .../>
 *   NEW: JSON array      ["5005","1","Y","<base64>"]
 *        where base64 = zlib(XML) + last-256-bytes(RSA signature)
 *
 * OVSE Compliance: All processing is local. No data leaves the device.
 */

const AadhaarParser = (() => {

  /* ------------------------------------------------------------------ *
   * UIDAI RSA-2048 Public Key (PEM)
   * Obtain the official key from UIDAI's OVSE documentation:
   *   https://uidai.gov.in/ecosystem/authentication-devices-documents/ovse
   *
   * Replace the value below with the actual UIDAI public key before
   * deploying to production.
   * ------------------------------------------------------------------ */
  const UIDAI_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Nnl7jMlPFAhzGKt8t
REPLACE_WITH_ACTUAL_UIDAI_RSA2048_PUBLIC_KEY_FROM_OVSE_DOCUMENTATION
AAAA==
-----END PUBLIC KEY-----`;

  /* ------------------------------------------------------------------ *
   * Internal helpers
   * ------------------------------------------------------------------ */

  /** Convert base64 string → Uint8Array */
  function b64ToBytes(b64) {
    const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** Strip PEM headers and convert to CryptoKey */
  async function importPublicKey(pem) {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = b64ToBytes(b64);
    return crypto.subtle.importKey(
      'spki', der.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
  }

  /** Verify RSA-SHA256 signature over data bytes */
  async function verifySignature(dataBytes, sigBytes) {
    try {
      const key = await importPublicKey(UIDAI_PUBLIC_KEY_PEM);
      return await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', key, sigBytes.buffer, dataBytes.buffer
      );
    } catch (e) {
      // Key placeholder is invalid — skip cryptographic verification in dev mode
      console.warn('[AadhaarParser] Signature verification skipped:', e.message);
      return null; // null = "not verified" (not "failed") — show warning to staff
    }
  }

  /** Extract year from various DOB formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYYMMDD */
  function parseDOB(dob) {
    if (!dob) return null;
    dob = dob.trim();
    // YYYY-MM-DD or YYYY/MM/DD
    if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(dob)) return { year: +dob.slice(0,4), month: +dob.slice(5,7), day: +dob.slice(8,10) };
    // DD-MM-YYYY or DD/MM/YYYY
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(dob)) return { day: +dob.slice(0,2), month: +dob.slice(3,5), year: +dob.slice(6,10) };
    // DDMMYYYY
    if (/^\d{8}$/.test(dob)) return { day: +dob.slice(0,2), month: +dob.slice(2,4), year: +dob.slice(4,8) };
    return null;
  }

  /** Calculate age from DOB object (conservative: if only year known, assume Dec 31) */
  function calculateAge(dobObj) {
    if (!dobObj) return null;
    const today = new Date();
    const birthDate = new Date(
      dobObj.year,
      (dobObj.month || 12) - 1,
      dobObj.day || 31
    );
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
  }

  /** Parse the XML string from an Aadhaar QR (both old plaintext and decompressed new) */
  function parseXmlData(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    // Check for XML parse errors
    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid XML in QR code');
    }

    // Find the data element — may be <PrintLetterBarcodeData> or root element
    const root = doc.documentElement;

    const attrs = (name) => root.getAttribute(name);

    const name    = attrs('name') || '';
    const gender  = attrs('gender') || '';
    const pincode = attrs('pc') || '';
    const yob     = attrs('yob');   // Year of Birth (old format — may be null)
    const dob     = attrs('dob');   // Full DOB (some versions)

    let dobObj = parseDOB(dob);
    if (!dobObj && yob) dobObj = { year: parseInt(yob), month: null, day: null };

    const age = calculateAge(dobObj);
    const hasFullDOB = !!(dob && parseDOB(dob));

    return { name, gender, pincode, dobObj, age, hasFullDOB };
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */
  return {

    /**
     * Detect QR content format.
     * Returns: 'old-xml' | 'new-secure' | 'aadhaar-number' | 'unknown'
     */
    detectFormat(qrText) {
      const t = qrText.trim();
      if (t.startsWith('<?xml') || t.startsWith('<PrintLetter')) return 'old-xml';
      if (t.startsWith('[') && t.includes('5005'))              return 'new-secure';
      if (/^\d{12}$/.test(t))                                   return 'aadhaar-number';
      return 'unknown';
    },

    /**
     * Main entry point. Parse any Aadhaar QR text.
     * Resolves with a result object or rejects with an error.
     *
     * Result shape:
     * {
     *   name:        string,
     *   gender:      string ('M' | 'F' | 'T'),
     *   pincode:     string,
     *   dobObj:      { year, month, day } | null,
     *   age:         number | null,
     *   hasFullDOB:  boolean,
     *   isVerified:  boolean | null,  // null = signature check skipped
     *   format:      string,
     * }
     */
    async parse(qrText) {
      const format = this.detectFormat(qrText.trim());

      if (format === 'aadhaar-number') {
        // 12-digit Aadhaar number only — cannot determine age without backend
        return { format, aadhaarNumber: qrText.trim(), age: null, isVerified: false };
      }

      if (format === 'old-xml') {
        const data = parseXmlData(qrText.trim());
        // Old-format QRs are not digitally signed — mark as unverified
        return { ...data, format, isVerified: false };
      }

      if (format === 'new-secure') {
        return this._parseNewSecure(qrText.trim());
      }

      throw new Error('Unrecognized QR code format. Please use an Aadhaar card QR code.');
    },

    /** Handle the new Secure QR (5005) format */
    async _parseNewSecure(qrText) {
      let arr;
      try {
        arr = JSON.parse(qrText);
      } catch {
        throw new Error('Malformed Secure QR data.');
      }

      if (!Array.isArray(arr) || arr[0] !== '5005') {
        throw new Error('Unsupported QR version: ' + arr[0]);
      }

      const encodedPayload = arr[3];
      if (!encodedPayload) throw new Error('Missing QR payload data.');

      // Decode base64 → raw bytes
      const rawBytes = b64ToBytes(encodedPayload);

      // Structure: [ zlib(xml) | RSA-2048 signature (256 bytes) ]
      const SIG_LENGTH = 256;
      if (rawBytes.length <= SIG_LENGTH) throw new Error('QR payload too short.');

      const compressedXml = rawBytes.slice(0, rawBytes.length - SIG_LENGTH);
      const signature     = rawBytes.slice(rawBytes.length - SIG_LENGTH);

      // Verify signature before trusting the data
      const isVerified = await verifySignature(compressedXml, signature);

      // Decompress XML — requires pako loaded in page
      let xmlBytes;
      try {
        xmlBytes = pako.inflate(compressedXml);
      } catch {
        throw new Error('Failed to decompress QR data. The QR may be corrupted.');
      }

      const xmlString = new TextDecoder('utf-8').decode(xmlBytes);
      const data = parseXmlData(xmlString);

      return { ...data, format: 'new-secure', isVerified };
    },

    /**
     * Determine eligibility.
     * Returns: 'adult' | 'minor' | 'borderline' | 'unknown'
     *
     * 'borderline' = YOB only, age calculation is ambiguous (within ±1 year of 21)
     */
    getEligibility(parseResult, legalAge = 21) {
      const { age, hasFullDOB } = parseResult;
      if (age === null) return 'unknown';
      if (age > legalAge) return 'adult';
      if (age < legalAge) return 'minor';
      // age === legalAge exactly
      if (!hasFullDOB) return 'borderline'; // could still be 20 (born Dec 31)
      return 'adult'; // full DOB confirms they've had their birthday
    },
  };

})();
