/**
 * liveDownload - VodDownloader
 * Parallel HLS/VOD segment downloader.
 *
 * Design principles:
 *  - No byte-range threading: HLS segments are already discrete TS/fMP4 chunks,
 *    so parallel-within-segment byte-ranging adds complexity with no benefit.
 *  - Batch concurrency: fetch N segments in parallel, write each batch in order.
 *  - AES-128-CBC decryption with key caching (same key often applies to many segments).
 *  - Init-segment caching: fMP4 HLS has a map segment written once, reused per segment.
 *  - Simple retry with exponential backoff and configurable tolerance.
 *  - Clean abort via AbortController.
 */

'use strict';

class VodDownloader {
  /**
   * @param {object} options
   * @param {number}   [options.concurrency=3]    Max parallel segment fetches
   * @param {number}   [options.retryTolerance=5] Max retries per segment before giving up
   * @param {number}   [options.retryDelay=500]   Base retry delay in ms (doubles each retry)
   * @param {Function} [options.onProgress]       Called with (completed, total, bytesLoaded)
   * @param {Function} [options.onError]          Called with (error, url) — return new URL string to override, or null to abort
   */
  constructor(options = {}) {
    this.concurrency    = options.concurrency    ?? 3;
    this.retryTolerance = options.retryTolerance ?? 5;
    this.retryDelay     = options.retryDelay     ?? 500;
    this.onProgress     = options.onProgress     || null;
    this.onError        = options.onError        || null;

    this._controller  = new AbortController();
    this._keyCache    = new Map();   // key URL → CryptoKey
    this._initCache   = new Map();   // init segment URL → ArrayBuffer
    this._bytesLoaded = 0;
  }

  /** Abort all in-progress fetches. */
  abort() {
    this._controller.abort(new Error('VodDownloader: aborted by caller'));
  }

  get aborted() {
    return this._controller.signal.aborted;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Download all segments and write to a FileSystem API file handle.
   *
   * @param {object[]} segments   Parsed segment objects from m3u8-parser
   * @param {FileSystemFileHandle} fileHandle
   */
  async download(segments, fileHandle) {
    if (!segments?.length) throw new Error('VodDownloader: no segments provided');

    // Pre-process: flatten init-map references so each logical segment is one item.
    // segment.map = { uri, resolvedUri } → init segment shared across many media segments.
    const expanded = this._expandSegments(segments);
    const total    = expanded.length;

    const writable = await fileHandle.createWritable();
    try {
      let completed = 0;

      for (let i = 0; i < expanded.length; i += this.concurrency) {
        if (this.aborted) throw new Error('VodDownloader: aborted');

        const batch = expanded.slice(i, i + this.concurrency);

        // Fetch batch in parallel — preserves array order for writing
        const buffers = await Promise.all(
          batch.map((seg, j) => this._fetchWithRetry(seg, i + j))
        );

        // Write batch in order
        for (const buf of buffers) {
          if (buf) {
            await writable.write(new Uint8Array(buf));
            this._bytesLoaded += buf.byteLength;
          }
          completed++;
          this.onProgress?.(completed, total, this._bytesLoaded);
        }
      }

      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Segment expansion
  // ---------------------------------------------------------------------------

  /**
   * Expand segment list: for fMP4 HLS, each segment may reference an init map.
   * The init segment must be written exactly once before the first segment that uses it.
   * Returns a flat list of items: { type: 'init'|'media', seg, position }.
   */
  _expandSegments(segments) {
    const result = [];
    let seenInitUrls = new Set();

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      // fMP4 init segment — write once per unique init URL
      if (seg.map) {
        const initUrl = this._resolveUrl({ uri: seg.map.resolvedUri || seg.map.uri, base: seg.base });
        if (!seenInitUrls.has(initUrl)) {
          seenInitUrls.add(initUrl);
          result.push({ type: 'init', url: initUrl, seg });
        }
      }

      result.push({ type: 'media', seg, position: i });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // URL resolution
  // ---------------------------------------------------------------------------

  _resolveUrl(segment) {
    if (segment.resolvedUri) return segment.resolvedUri;
    try {
      const url = new URL(segment.uri, segment.base || undefined);
      // Preserve base query params if segment URL has no query (SOOP/Twitch pattern)
      if (!url.search && segment.base) {
        try {
          const baseQuery = new URL(segment.base).search;
          if (baseQuery) return url.href + baseQuery;
        } catch (_) {}
      }
      return url.href;
    } catch (_) {
      return segment.uri;
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch with retry
  // ---------------------------------------------------------------------------

  async _fetchWithRetry(item, position) {
    let lastError;
    let delay = this.retryDelay;

    for (let attempt = 0; attempt <= this.retryTolerance; attempt++) {
      if (this.aborted) throw new Error('VodDownloader: aborted');

      try {
        if (item.type === 'init') {
          return await this._fetchInit(item.url);
        } else {
          return await this._fetchSegment(item.seg, item.position ?? position);
        }
      } catch (e) {
        if (this._controller.signal.aborted) throw e;

        lastError = e;
        console.warn(`[VodDownloader] Segment ${position} attempt ${attempt + 1}/${this.retryTolerance + 1} failed: ${e.message}`);

        if (attempt < this.retryTolerance) {
          await this._sleep(delay);
          delay = Math.min(delay * 2, 20000); // exponential backoff, cap at 20s
        }
      }
    }

    // All retries exhausted — give the caller a chance to override the URL
    if (this.onError) {
      const url  = item.url || this._resolveUrl(item.seg);
      const newUrl = await this.onError(lastError, url);
      if (newUrl) {
        // Retry once with the overridden URL
        if (item.type === 'init') {
          item.url = newUrl;
        } else {
          item.seg = { ...item.seg, resolvedUri: newUrl };
        }
        return this._fetchWithRetry(item, position);
      }
    }

    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // Init segment fetching (cached)
  // ---------------------------------------------------------------------------

  async _fetchInit(url) {
    if (this._initCache.has(url)) {
      return this._initCache.get(url);
    }
    const r = await fetch(url, {
      credentials: 'include',
      signal: this._controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching init segment: ${url}`);
    const buf = await r.arrayBuffer();
    this._initCache.set(url, buf);
    return buf;
  }

  // ---------------------------------------------------------------------------
  // Media segment fetching + decryption
  // ---------------------------------------------------------------------------

  async _fetchSegment(seg, position) {
    const url = this._resolveUrl(seg);
    const r   = await fetch(url, {
      credentials: 'include',
      signal: this._controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching segment: ${url}`);

    const buf = await r.arrayBuffer();

    if (seg.key) {
      return this._decrypt(buf, seg, position);
    }
    return buf;
  }

  // ---------------------------------------------------------------------------
  // AES-128-CBC decryption
  // ---------------------------------------------------------------------------

  async _decrypt(buffer, seg, position) {
    const method = seg.key.method?.toUpperCase();
    if (method !== 'AES-128') {
      throw new Error(`VodDownloader: unsupported encryption method: ${method}`);
    }

    const keyUrl = new URL(seg.key.uri, seg.base || seg.uri).href;

    if (!this._keyCache.has(keyUrl)) {
      const r = await fetch(keyUrl, {
        credentials: 'include',
        signal: this._controller.signal
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching AES key: ${keyUrl}`);
      const keyData   = await r.arrayBuffer();
      const cryptoKey = await crypto.subtle.importKey(
        'raw', keyData, { name: 'AES-CBC' }, false, ['decrypt']
      );
      this._keyCache.set(keyUrl, cryptoKey);
    }

    const cryptoKey = this._keyCache.get(keyUrl);

    // IV: explicit from manifest, or derived from segment sequence number (HLS spec §4.3.2.4)
    let iv;
    if (seg.key?.iv) {
      iv = seg.key.iv.buffer;
    } else {
      const ivBytes = new Uint8Array(16);
      for (let i = 12; i < 16; i++) {
        ivBytes[i] = ((position + 1) >> (8 * (15 - i))) & 0xFF;
      }
      iv = ivBytes.buffer;
    }

    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Format bytes as human-readable string.
   * Matches the legacy size() interface.
   */
  static size(bytes, si = true, dp = 1) {
    bytes = Number(bytes);
    const thresh = si ? 1000 : 1024;
    if (Math.abs(bytes) < thresh) return bytes + ' B';
    const units = si
      ? ['KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
      : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10 ** dp;
    do { bytes /= thresh; ++u; }
    while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);
    return bytes.toFixed(dp) + ' ' + units[u];
  }
}

// Expose globally for index.js
self.VodDownloader = VodDownloader;

// ---------------------------------------------------------------------------
// Static helpers (guess, size) — ported and rewritten from scratch
// ---------------------------------------------------------------------------

VodDownloader._MIME_TYPES = {
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegURL': 'm3u8',
  'audio/mpegurl': 'm3u8',
  'audio/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'video/MP2T': 'ts',
  'video/3gpp': '3gp',
  'video/mpeg': 'mpg',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/octet-stream': 'bin'
};

/**
 * Guess filename and extension from a Response object.
 * Guesses MIME type from URL extension.
 */
VodDownloader.guess = function(resp, meta = {}) {
  const href = resp.url.split('#')[0].split('?')[0];
  const disposition = resp.headers.get('Content-Disposition');
  let name = '';

  if (disposition) {
    const tmp = /filename\*=UTF-8''([^;]*)/.exec(disposition);
    if (tmp) name = decodeURIComponent(tmp[1].replace(/["']$/, '').replace(/^["']/, ''));
  }
  if (!name && disposition) {
    const tmp = /filename=([^;]*)/.exec(disposition);
    if (tmp) name = tmp[1].replace(/["']$/, '').replace(/^["']/, '');
  }
  if (!name) {
    if (href.startsWith('data:')) {
      const mime = href.split('data:')[1].split(';')[0];
      meta.ext  = (VodDownloader._MIME_TYPES[mime] || mime.split('/')[1] || '').split(';')[0];
      meta.mime = mime;
      name = '';
    } else {
      name = (href.substring(href.lastIndexOf('/') + 1) || 'unknown').slice(-100);
    }
  }
  name = name || 'unknown';
  const e = /(.+)\.([^.]{1,6})*$/.exec(name);
  name = e ? e[1] : name;
  meta.mime = resp.headers.get('Content-Type') || meta.mime || '';
  meta.ext  = e ? e[2] : (VodDownloader._MIME_TYPES[meta.mime] || meta.mime.split('/')[1] || '').split(';')[0];
  meta.ext  = (meta.ext || '').slice(0, 15);
  meta.name = decodeURIComponent(name) || meta.name;
};
