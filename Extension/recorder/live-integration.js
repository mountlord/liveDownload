/* liveDownload — Live Stream Recording Engine */

(function () {
  'use strict';

  const VERSION = '0.7.30.08';
  console.log(`[liveDownload] Loading v${VERSION}...`);

  // ─── Constants ──────────────────────────────────────────────────────────────

  const POLL_INTERVAL               = 3000;   // ms between manifest polls
  const SEEN_SET_MAX_SIZE           = 2000;   // max segment URLs remembered
  const MAX_SEGMENT_RETRIES         = 3;
  const SEGMENT_TIMEOUT             = 30000;  // ms
  const MANIFEST_TIMEOUT            = 10000;  // ms
  const DEFAULT_RECOVERY_POLL_INTERVAL      = 5;    // minutes
  const DEFAULT_MAX_ERRORS_BEFORE_RECOVERY  = 100;  // ~5 min at 3s interval

  // ─── Filename helpers ───────────────────────────────────────────────────────

  /**
   * Build a timestamped filename for a new recording file.
   * Uses self.getHumanTimestamp() from helper.js — single source of truth.
   */
  function createLiveFilename(baseTitle) {
    return `${baseTitle}-${self.getHumanTimestamp()}`;
  }

  /**
   * Strip any known timestamp suffix from a filename to recover the clean base.
   * Handles all historical formats so recovery files share the same base name.
   */
  function stripTimestampFromFilename(filename) {
    // With seconds: -Mar-27-2026-10-33-05AM
    const withSecs = /-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}-\d{1,2}-\d{2}-\d{2}(?:AM|PM)$/i;
    if (withSecs.test(filename)) return filename.replace(withSecs, '');

    // Without seconds (legacy): -Mar-27-2026-10-33AM
    const noSecs = /-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}-\d{1,2}-\d{2}(?:AM|PM)$/i;
    if (noSecs.test(filename)) return filename.replace(noSecs, '');

    // ISO-like (legacy): _2026-03-27T19-04
    const iso = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/;
    if (iso.test(filename)) return filename.replace(iso, '');

    // Underscore (legacy): _Mar-27-2026_10-33AM
    const underscore = /_(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}_\d{1,2}-\d{2}(?:AM|PM)$/i;
    if (underscore.test(filename)) return filename.replace(underscore, '');

    return filename;
  }

  // ─── General utilities ──────────────────────────────────────────────────────

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function fetchWithTimeout(url, options = {}, timeoutMs = SEGMENT_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function isRetriableError(error, status) {
    if (error?.name === 'AbortError') return true;   // timeout
    if (error?.name === 'TypeError')  return true;   // network error
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return false;
  }

  function isTerminalError(status) {
    return status === 401 || status === 403;
  }

  // ─── Data structures ────────────────────────────────────────────────────────

  /** Fixed-capacity Set with FIFO eviction to bound memory use. */
  class BoundedSet {
    constructor(maxSize) {
      this.maxSize = maxSize;
      this.set     = new Set();
      this.queue   = [];
    }
    has(v)  { return this.set.has(v); }
    add(v)  {
      if (this.set.has(v)) return;
      this.set.add(v);
      this.queue.push(v);
      while (this.queue.length > this.maxSize) this.set.delete(this.queue.shift());
    }
    get size() { return this.set.size; }
    clear() { this.set.clear(); this.queue = []; }
  }

  // ─── HLS playlist helpers ───────────────────────────────────────────────────

  /**
   * Parse a master playlist and return variant streams sorted highest quality first.
   * Returns null if the URL is not a master playlist.
   */
  async function parseMasterPlaylist(url) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      const text     = await response.text();

      if (!text.includes('#EXT-X-STREAM-INF')) return null;

      const baseUrl  = new URL(url);
      const variants = [];
      const lines    = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

        const attrs    = line.substring('#EXT-X-STREAM-INF:'.length);
        const bwMatch  = attrs.match(/BANDWIDTH=(\d+)/);
        const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);

        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next || next.startsWith('#')) continue;
          variants.push({
            url:       next.startsWith('http') ? next : new URL(next, baseUrl).href,
            width:     resMatch ? parseInt(resMatch[1]) : 0,
            height:    resMatch ? parseInt(resMatch[2]) : 0,
            bandwidth: bwMatch  ? parseInt(bwMatch[1])  : 0
          });
          break;
        }
      }

      variants.sort((a, b) => b.height !== a.height ? b.height - a.height : b.bandwidth - a.bandwidth);

      console.log(`[liveDownload] Parsed master playlist, found ${variants.length} variants`);
      variants.forEach((v, i) => console.log(`[liveDownload]   ${i}: ${v.width}x${v.height} @ ${v.bandwidth} bps`));

      return variants;
    } catch (e) {
      console.error('[liveDownload] Error parsing master playlist:', e);
      return null;
    }
  }

  /**
   * Resolve a master playlist URL to the highest-quality media playlist.
   * Returns the URL unchanged if it is already a media playlist.
   */
  async function resolveToMediaPlaylist(url) {
    const variants = await parseMasterPlaylist(url);
    return (variants && variants.length > 0) ? variants[0].url : url;
  }

  /**
   * Return true if the URL points to an active live HLS stream.
   * Follows master → media playlist resolution automatically.
   */
  async function isLiveStream(url) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      const text     = await response.text();

      if (text.includes('#EXT-X-STREAM-INF')) {
        console.log('[liveDownload] Master playlist detected, resolving to media playlist...');
        const variants = await parseMasterPlaylist(url);
        return (variants && variants.length > 0) ? isLiveStream(variants[0].url) : false;
      }

      return text.includes('#EXT-X-TARGETDURATION') && !text.includes('#EXT-X-ENDLIST');
    } catch (e) {
      console.error('[liveDownload] Error checking if live:', e);
      return false;
    }
  }

  // ─── Tab autoplay injection ─────────────────────────────────────────────────

  /**
   * Inject player-click events into a tab to bypass certain autoplay gate.
   * Used during recovery polling when a new monitoring tab is opened.
   */
  async function _injectTabAutoplay(tabId) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          function fireClick(el) {
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type =>
              el.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window,
                clientX: el.getBoundingClientRect().left + el.offsetWidth  / 2,
                clientY: el.getBoundingClientRect().top  + el.offsetHeight / 2
              }))
            );
          }

          const stopScreen = document.querySelector('#stop_screen');
          if (stopScreen?.offsetParent) { fireClick(stopScreen); return 'stop-screen'; }

          const playerDiv = document.querySelector('#afreecatv_player');
          if (playerDiv) { fireClick(playerDiv); return 'player-div'; }

          for (const el of document.querySelectorAll('button,[role="button"],a,div')) {
            if (!el.offsetParent) continue;
            const c  = el.className?.toLowerCase()          || '';
            const ar = el.getAttribute('aria-label')?.toLowerCase() || '';
            if (c.includes('btn_play') || c.includes('play-btn') || ar.includes('play')) {
              fireClick(el); return 'play-button';
            }
          }

          const video = document.querySelector('video');
          if (video) { fireClick(video); return 'video-click'; }
          return 'no-element';
        }
      });
      const method = result?.[0]?.result;
      if (method && method !== 'no-element') {
        console.log(`[liveDownload] 🎬 Recovery tab autoplay injected (tab ${tabId}): ${method}`);
      }
    } catch {
      // Tab may not be ready yet — caller will retry
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HLSEngine — shared base class (purple region)
  //
  // Owns the core segment acquisition loop:
  //   check()          → poll manifest, enqueue new segments
  //   processQueue()   → drain the queue one segment at a time
  //   downloadSegment()→ fetch one segment URL and write bytes to outputWritable
  //
  // All browser-API callbacks (UI, Chrome messaging, file I/O decisions) are
  // delegated to hook methods that LiveMonitor overrides.
  // ═══════════════════════════════════════════════════════════════════════════

  class HLSEngine {
    constructor(manifestUrl) {
      this.url             = manifestUrl;
      this.active          = false;
      this.stopping        = false;
      this.checkInFlight   = false;
      this.downloadInFlight = false;
      this.isWaitingForStream  = false;
      this.isInRecoveryMode    = false;

      this.consecutiveManifestErrors    = 0;
      this.settingsFetchedForErrorBatch = false;
      this.lastSuccessfulFetch          = null;

      // Settings — populated by _loadSettings() in LiveMonitor
      this.resilientMode            = true;
      this.maxManifestErrors        = 10;
      this.maxErrorsBeforeRecovery  = DEFAULT_MAX_ERRORS_BEFORE_RECOVERY;
      this.translateTitles          = false;

      this.seen             = new BoundedSet(SEEN_SET_MAX_SIZE);
      this.pendingSegments  = [];
      this.outputWritable   = null;

      this.metrics = {
        segmentsFound:               0,
        segmentsDownloaded:          0,
        segmentsFailed:              0,
        segmentsRetried:             0,
        bytesDownloaded:             0,  // cumulative across all files
        currentFileBytesDownloaded:  0   // current file only, reset on recovery
      };
    }

    // ── Hook stubs (overridden by LiveMonitor) ────────────────────────────────

    async reloadSettings()          {}
    updateUI()                      {}
    updateHeaderState(_state)       {}
    showNotification(_msg, _type)   {}
    async enterRecoveryMode(_reason) {}
    async stop()                    {}

    // ── Core engine ───────────────────────────────────────────────────────────

    /**
     * Poll the manifest for new segments and enqueue them.
     * Handles HTTP errors, network errors, and stream-end detection.
     */
    async check() {
      if (!this.active || this.stopping || this.checkInFlight || this.isInRecoveryMode) return;
      this.checkInFlight = true;

      try {
        const response = await fetchWithTimeout(
          this.url,
          { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } },
          MANIFEST_TIMEOUT
        );

        if (!response.ok) {
          if (!this.settingsFetchedForErrorBatch) {
            await this.reloadSettings();
            this.settingsFetchedForErrorBatch = true;
          }

          this.consecutiveManifestErrors++;

          if (this.consecutiveManifestErrors === 1 || this.consecutiveManifestErrors % 10 === 0) {
            console.warn(`[liveDownload] Manifest fetch failed (${response.status}), consecutive: ${this.consecutiveManifestErrors}`);
          }

          if (!this.isWaitingForStream) {
            this.isWaitingForStream = true;
            this.updateHeaderState('waiting');
          }
          this.updateUI();

          if (isTerminalError(response.status)) {
            console.log('[liveDownload] Auth error (401/403) — stream may have restarted');
            if (this.resilientMode) {
              await this.enterRecoveryMode('Auth token expired — broadcaster may have restarted');
            } else {
              this.showNotification('Stream authentication expired', 'warning');
              await this.stop();
            }
            return;
          }

          if (this.resilientMode && this.consecutiveManifestErrors >= this.maxErrorsBeforeRecovery) {
            console.log(`[liveDownload] ${this.consecutiveManifestErrors} consecutive errors — entering recovery`);
            await this.enterRecoveryMode(`${this.consecutiveManifestErrors} consecutive errors`);
            return;
          }

          if (!this.resilientMode && this.consecutiveManifestErrors >= this.maxManifestErrors) {
            console.log(`[liveDownload] ${this.maxManifestErrors} consecutive errors — stream likely ended`);
            this.showNotification(`Stream ended or unavailable (${this.maxManifestErrors} consecutive errors)`, 'warning');
            await this.stop();
          }
          return;
        }

        // ── Successful fetch ──────────────────────────────────────────────────

        if (this.consecutiveManifestErrors > 0) {
          console.log(`[liveDownload] Stream recovered after ${this.consecutiveManifestErrors} errors`);
        }
        this.consecutiveManifestErrors    = 0;
        this.settingsFetchedForErrorBatch = false;
        this.lastSuccessfulFetch          = Date.now();

        if (this.isWaitingForStream) {
          this.isWaitingForStream = false;
          this.updateHeaderState('recording');
          this.showNotification('Stream connection restored!', 'success');
        }

        const text = await response.text();

        if (text.includes('#EXT-X-ENDLIST')) {
          console.log('[liveDownload] Stream ended (ENDLIST)');
          await this.stop();
          return;
        }

        const parser = new m3u8Parser.Parser();
        parser.push(text);
        parser.end();

        const segments = parser.manifest?.segments;
        if (segments) {
          let newCount = 0;
          for (const seg of segments) {
            const uri = new URL(seg.uri, this.url).href;
            if (!this.seen.has(uri)) {
              this.seen.add(uri);
              this.pendingSegments.push({ ...seg, resolvedUri: uri, retryCount: 0 });
              this.metrics.segmentsFound++;
              newCount++;
            }
          }
          if (newCount > 0) {
            console.log(`[liveDownload] +${newCount} segments (total: ${this.metrics.segmentsFound}, pending: ${this.pendingSegments.length})`);
            this.updateUI();
          }
        }

      } catch (e) {
        // Network-level error
        if (!this.settingsFetchedForErrorBatch) {
          await this.reloadSettings();
          this.settingsFetchedForErrorBatch = true;
        }

        this.consecutiveManifestErrors++;

        if (e.name === 'AbortError') {
          console.warn(`[liveDownload] Manifest timeout, consecutive: ${this.consecutiveManifestErrors}`);
        } else {
          console.error(`[liveDownload] check() error (consecutive: ${this.consecutiveManifestErrors}):`, e);
        }

        if (!this.isWaitingForStream) {
          this.isWaitingForStream = true;
          this.updateHeaderState('waiting');
        }
        this.updateUI();

        if (this.resilientMode && this.consecutiveManifestErrors >= this.maxErrorsBeforeRecovery) {
          console.log(`[liveDownload] ${this.consecutiveManifestErrors} consecutive errors — entering recovery`);
          await this.enterRecoveryMode(`${this.consecutiveManifestErrors} consecutive errors`);
          return;
        }

        if (!this.resilientMode && this.consecutiveManifestErrors >= this.maxManifestErrors) {
          console.log(`[liveDownload] ${this.maxManifestErrors} consecutive errors — stopping`);
          await this.stop();
        }

      } finally {
        this.checkInFlight = false;
      }
    }

    /**
     * Drain the pending segment queue, downloading one at a time.
     * Failed segments are re-queued up to MAX_SEGMENT_RETRIES times.
     */
    async processQueue() {
      if (this.downloadInFlight || this.stopping || this.isInRecoveryMode) return;

      while (this.pendingSegments.length > 0 && this.active && !this.stopping && !this.isInRecoveryMode) {
        this.downloadInFlight = true;

        const segment = this.pendingSegments.shift();
        const success = await this.downloadSegment(segment);

        if (!success && segment._retriable && segment.retryCount < MAX_SEGMENT_RETRIES) {
          segment.retryCount++;
          this.pendingSegments.push(segment);
          this.metrics.segmentsRetried++;
          console.log(`[liveDownload] Segment queued for retry (attempt ${segment.retryCount}/${MAX_SEGMENT_RETRIES})`);
        }

        this.downloadInFlight = false;
        this.updateUI();
      }
    }

    /**
     * Fetch one segment and append its bytes to the output file.
     * Segment fetch pipeline runs entirely in Rust/WASM (SegmentFetcher).
     * JS owns only the fetch() call and the file write — the retry loop,
     * timeout management, and error classification are compiled Rust.
     * If WASM is not loaded the recording cannot proceed — throws immediately.
     * Returns true on success, false on any failure.
     */
    async downloadSegment(segment) {
      const url = segment.resolvedUri || segment.uri;
      segment._retriable = false;

      // WASM must be loaded — no JS fallback by design
      if (!window.__ldWasm?.SegmentFetcher) {
        throw new Error('[liveDownload] WASM module not loaded — cannot record. Reload the extension.');
      }

      // Lazily create one SegmentFetcher per LiveMonitor instance
      if (!this._segmentFetcher) {
        this._segmentFetcher = new window.__ldWasm.SegmentFetcher(
          MAX_SEGMENT_RETRIES, SEGMENT_TIMEOUT
        );
      }

      // JS fetch bridge — called by Rust for each attempt.
      // Rust drives retry/timeout/classification; JS owns fetch() and write().
      const fetchBridge = async (segUrl, timeoutMs) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(segUrl, {
            cache: 'no-cache',
            signal: controller.signal
          });
          const bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
          return { status: r.status, bytes, error: null };
        } catch (e) {
          return { status: 0, bytes: null, error: e.message };
        } finally {
          clearTimeout(timer);
        }
      };

      const result = await this._segmentFetcher.run(url, fetchBridge);
      const S = window.__ldWasm.SegmentStatus;

      switch (result.status()) {
        case S.Success: {
          const bytes = result.bytes();
          if (this.outputWritable) {
            await this.outputWritable.write(bytes);
          }
          this.metrics.segmentsDownloaded++;
          this.metrics.bytesDownloaded            += bytes.byteLength;
          this.metrics.currentFileBytesDownloaded += bytes.byteLength;
          return true;
        }
        case S.Expired:
          console.warn(`[liveDownload] Segment expired (404): …${url.slice(-40)}`);
          this.metrics.segmentsFailed++;
          return false;
        case S.Terminal:
          console.warn(`[liveDownload] Segment auth error: ${result.message()}`);
          this.consecutiveManifestErrors++;
          this.metrics.segmentsFailed++;
          return false;
        case S.Retriable:
          console.warn(`[liveDownload] Segment retriable: ${result.message()}`);
          segment._retriable = true;
          this.metrics.segmentsFailed++;
          return false;
        default: // Failed
          console.error(`[liveDownload] Segment failed: ${result.message()}`);
          this.metrics.segmentsFailed++;
          return false;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LiveMonitor — full live-stream recording engine (extends HLSEngine)
  //
  // Adds:
  //   Lifecycle   : start(), runLoop(), stop()
  //   File I/O    : _openOutputFile(), requestDirectoryAccess(), triggerOPFSDownload()
  //   Filename    : _resolveFilename()
  //   Settings    : _loadSettings(), reloadSettings()
  //   Recovery    : enterRecoveryMode(), saveCurrentRecording(),
  //                 startRecoveryPolling(), stopRecoveryPolling(),
  //                 pollForNewManifest(), resumeRecording()
  //   UI          : showUI(), updateUI(), updateHeaderState(), updateDuration(),
  //                 showNotification(), showCompletionScreen(), logMetrics()
  //   Chrome APIs : registerRecording(), unregisterRecording(), updateRecordingStats(),
  //                 checkReenterWaiting(), userStop()
  // ═══════════════════════════════════════════════════════════════════════════

  class LiveMonitor extends HLSEngine {

    constructor(manifestUrl, baseFilename, codec) {
      super(manifestUrl);

      this.originalUrl          = manifestUrl;
      this.originalFilenameBase = stripTimestampFromFilename(baseFilename);
      this.originalFilename     = baseFilename;
      this.baseFilename         = baseFilename;
      this.codec                = codec;

      console.log(`[liveDownload] Filename: "${baseFilename}" → base: "${this.originalFilenameBase}"`);

      // Recovery state
      this.fileIncrement      = 0;
      this.recoveryPollTimer  = null;
      this.recoveryStartTime  = null;
      this.recoveryPollInterval = DEFAULT_RECOVERY_POLL_INTERVAL;

      // File handles
      this.directoryHandle    = null;
      this.finalFileHandle    = null;
      this.usingOPFS          = false;
      this.directoryName      = 'Downloads';

      // Timing
      this.startTime          = null;
      this.durationTimer      = null;
      this.recordingWindowId  = null;

      // Extract tab/page context from recorder URL params
      const params    = new URLSearchParams(window.location.search);
      this.tabId      = parseInt(params.get('tabId'))  || null;
      this.pageUrl    = params.get('href')              || null;
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    async _loadSettings() {
      try {
        const s = await chrome.storage.local.get({
          'liveDownload_resilientMode':             true,
          'liveDownload_maxManifestErrors':         10,
          'liveDownload_recoveryPollInterval':      DEFAULT_RECOVERY_POLL_INTERVAL,
          'liveDownload_maxErrorsBeforeRecovery':   DEFAULT_MAX_ERRORS_BEFORE_RECOVERY,
          'liveDownload_translateTitles':           false
        });
        this.resilientMode           = s['liveDownload_resilientMode'];
        this.maxManifestErrors       = s['liveDownload_maxManifestErrors'];
        this.recoveryPollInterval    = s['liveDownload_recoveryPollInterval'];
        this.maxErrorsBeforeRecovery = s['liveDownload_maxErrorsBeforeRecovery'];
        this.translateTitles         = s['liveDownload_translateTitles'];
        console.log(`[liveDownload] Settings: resilientMode=${this.resilientMode}, recoveryPollInterval=${this.recoveryPollInterval}min, maxErrorsBeforeRecovery=${this.maxErrorsBeforeRecovery}, translateTitles=${this.translateTitles}`);
      } catch {
        console.warn('[liveDownload] Could not load settings, using defaults');
      }
    }

    /** Reload settings mid-session (called on first error of each error batch). */
    async reloadSettings() {
      try {
        const s = await chrome.storage.local.get({
          'liveDownload_resilientMode':            true,
          'liveDownload_maxManifestErrors':        10,
          'liveDownload_recoveryPollInterval':     DEFAULT_RECOVERY_POLL_INTERVAL,
          'liveDownload_maxErrorsBeforeRecovery':  DEFAULT_MAX_ERRORS_BEFORE_RECOVERY,
          'liveDownload_translateTitles':          false
        });
        this.resilientMode           = s['liveDownload_resilientMode'];
        this.maxManifestErrors       = s['liveDownload_maxManifestErrors'];
        this.recoveryPollInterval    = s['liveDownload_recoveryPollInterval'];
        this.maxErrorsBeforeRecovery = s['liveDownload_maxErrorsBeforeRecovery'];
        this.translateTitles         = s['liveDownload_translateTitles'];
        console.log(`[liveDownload] Settings reloaded: maxErrorsBeforeRecovery=${this.maxErrorsBeforeRecovery}`);
      } catch {
        console.warn('[liveDownload] Could not reload settings');
      }
    }

    // ── Filename resolution ───────────────────────────────────────────────────

    /**
     * Translate the base title if enabled, then stamp the final filename.
     * Sets this.originalFilenameBase (translated), this.originalFilename,
     * and this.baseFilename.
     */
    async _resolveFilename() {
      if (this.translateTitles) {
        try {
          const translated = await self.translateText(this.originalFilenameBase);
          if (translated && translated !== this.originalFilenameBase) {
            console.log(`[liveDownload] Translated: "${this.originalFilenameBase}" → "${translated}"`);
            this.originalFilenameBase = translated;
          }
        } catch (e) {
          console.warn('[liveDownload] Translation failed, using original:', e.message);
        }
      }
      this.originalFilename = createLiveFilename(this.originalFilenameBase);
      this.baseFilename     = this.originalFilename;
      console.log(`[liveDownload] Final filename: "${this.originalFilename}"`);
    }

    // ── File I/O ──────────────────────────────────────────────────────────────

    /**
     * Create the output file and open a writable stream.
     * Shared by start() and resumeRecording() — single source of truth for
     * file creation so both paths behave identically.
     *
     * @param {string} filename  — name without extension
     * @returns {string}         — file extension used (e.g. 'ts')
     */
    async _openOutputFile(filename) {
      const ext          = document.getElementById('default-format')?.value || 'ts';
      const fullName     = `${filename}.${ext}`;

      if (this.usingOPFS) {
        const prefix   = Math.random().toString(36).substring(2, 8);
        this.finalFileHandle = await this.directoryHandle.getFileHandle(`${prefix} - ${fullName}`, { create: true });
      } else {
        this.finalFileHandle = await this.directoryHandle.getFileHandle(fullName, { create: true });
      }

      this.outputWritable = await this.finalFileHandle.createWritable();
      console.log(`[liveDownload] Opened output file: ${fullName}`);
      return ext;
    }

    /**
     * Resolve directory access for the recording session.
     *
     * Returns:
     *   true           — directory ready to use
     *   'needs-reauth' — handle exists but Chrome needs re-authorization (user gesture required)
     *   false          — no directory available, unrecoverable
     *
     * Never silently falls back to OPFS when a directory has been previously configured —
     * that would route recordings to the wrong location without the user knowing.
     */
    async requestDirectoryAccess() {
      // OPFS already configured by auto-record caller
      if (this.usingOPFS && window._liveDownloadDirectory) {
        this.directoryHandle = window._liveDownloadDirectory;
        console.log('[liveDownload] Using pre-configured OPFS directory');
        return true;
      }

      const hasNativeAPI = typeof window.showDirectoryPicker === 'function' &&
                           !window.showDirectoryPicker._polyfilled;
      if (!hasNativeAPI) {
        console.log('[liveDownload] Native File System API unavailable — using OPFS');
        this.usingOPFS = true;
      }

      // Cached session directory (permission already granted this session)
      if (window._liveDownloadDirectory && !this.usingOPFS) {
        try {
          const perm = await window._liveDownloadDirectory.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            this.directoryHandle = window._liveDownloadDirectory;
            this.directoryName   = window._liveDownloadDirectory.name || 'Downloads';
            console.log('[liveDownload] Using cached directory');
            return true;
          }
        } catch {
          window._liveDownloadDirectory = null;
        }
      }

      // Directory from settings (persisted in IndexedDB across restarts)
      const savedDir = window.getRootDirectory?.();
      if (savedDir && !this.usingOPFS) {
        try {
          const perm = await savedDir.queryPermission({ mode: 'readwrite' });

          if (perm === 'granted') {
            this.directoryHandle          = savedDir;
            this.directoryName            = savedDir.name || 'Downloads';
            window._liveDownloadDirectory = savedDir;
            console.log('[liveDownload] Using directory from settings:', savedDir.name);
            return true;
          }

          if (perm === 'prompt') {
            // Chrome requires a user gesture to call requestPermission().
            // Signal to start() that we need the user to click a reauth button.
            console.log(`[liveDownload] Directory "${savedDir.name}" needs re-authorization`);
            this._pendingReauthDir = savedDir;
            return 'needs-reauth';
          }

          // perm === 'denied'
          console.warn('[liveDownload] Permission denied for stored directory');
          this._pendingReauthDir = savedDir;
          return 'needs-reauth';

        } catch {
          console.warn('[liveDownload] Saved directory no longer accessible');
        }
      }

      // OPFS fallback (Brave, Firefox — no configured directory)
      if (this.usingOPFS) {
        try {
          this.directoryHandle          = await navigator.storage.getDirectory();
          this.directoryName            = 'Downloads';
          window._liveDownloadDirectory = this.directoryHandle;
          console.log('[liveDownload] Using OPFS (will trigger download on completion)');
          return true;
        } catch (e) {
          console.error('[liveDownload] OPFS access failed:', e);
          return false;
        }
      }

      // No directory configured at all — ask user (requires user gesture from clicking Record)
      try {
        this.directoryHandle          = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        this.directoryName            = this.directoryHandle.name || 'Downloads';
        window._liveDownloadDirectory = this.directoryHandle;
        console.log('[liveDownload] Directory selected and cached');
        return true;
      } catch (e) {
        console.error('[liveDownload] Directory access denied:', e);
        return false;
      }
    }

    /**
     * Re-authorize the configured directory after a Chrome restart.
     * Called when the user clicks the reauth banner button — provides the
     * user gesture needed for requestPermission().
     */
    async reauthDirectory() {
      const dir = this._pendingReauthDir;
      if (!dir) return false;

      try {
        const perm = await dir.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          this.directoryHandle          = dir;
          this.directoryName            = dir.name || 'Downloads';
          window._liveDownloadDirectory = dir;
          this._pendingReauthDir        = null;
          console.log(`[liveDownload] Re-authorization granted for: ${dir.name}`);
          return true;
        }
        console.warn('[liveDownload] Re-authorization denied');
        return false;
      } catch (e) {
        console.error('[liveDownload] Re-authorization error:', e);
        return false;
      }
    }

    /** Trigger a browser download for an OPFS-backed recording (Brave/Firefox). */
    async triggerOPFSDownload() {
      try {
        if ('download' in this.finalFileHandle) {
          await this.finalFileHandle.download();
        } else {
          const file = await this.finalFileHandle.getFile();
          const url  = URL.createObjectURL(file);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = this.finalFileHandle.name.includes(' - ')
            ? this.finalFileHandle.name.split(' - ').slice(1).join(' - ')
            : this.finalFileHandle.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        console.log('[liveDownload] OPFS download triggered');
      } catch (e) {
        console.error('[liveDownload] OPFS download failed:', e);
      }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Begin a live recording session.
     *
     * @param {object[]} initialSegments  — segments already detected before start
     * @param {FileSystemFileHandle|null} finalFileHandle — pre-created handle (manual
     *   record via file picker) or null (auto-record, file created here)
     */
    async start(initialSegments, finalFileHandle) {
      this.active   = true;
      this.stopping = false;
      this.startTime           = Date.now();
      this.lastSuccessfulFetch = Date.now();

      // 1. Load settings
      await this._loadSettings();

      // 2. Translate title + stamp filename
      await this._resolveFilename();

      // 3. Resolve master playlist → highest-quality media playlist
      const resolvedUrl = await resolveToMediaPlaylist(this.url);
      if (resolvedUrl !== this.url) {
        console.log('[liveDownload] Resolved master playlist to:', resolvedUrl.substring(0, 80) + '...');
        this.url      = resolvedUrl;
        initialSegments = [];   // segments from wrong playlist — discard
      }

      // 4. Show live recording UI
      this.showUI();

      // 5. Resolve directory access
      const dirResult = await this.requestDirectoryAccess();

      if (dirResult === 'needs-reauth') {
        // Directory configured but Chrome needs re-authorization.
        // Check if this is an auto-record (no user present to click the banner).
        const params = new URLSearchParams(window.location.search);
        const isAutoRecord = params.get('autoRecord') === 'true';

        if (isAutoRecord) {
          // Unattended auto-record — fall back to OPFS silently so recording
          // starts immediately. User can fix the directory in Settings later.
          console.log('[liveDownload] Auto-record: directory needs reauth, falling back to OPFS');
          try {
            this.directoryHandle          = await navigator.storage.getDirectory();
            this.directoryName            = 'Downloads';
            this.usingOPFS                = true;
            window._liveDownloadDirectory = this.directoryHandle;
          } catch (e) {
            console.error('[liveDownload] OPFS fallback failed:', e);
            throw new Error('Storage unavailable');
          }
        } else {
          // Manual record — user is watching the window, show the reauth banner.
          this._pendingStartArgs = { initialSegments, finalFileHandle };
          this._showReauthBanner();
          this.active   = false;
          this.stopping = false;
          return;
        }
      }

      if (!dirResult) {
        throw new Error('Directory access required');
      }

      // 6. Open output file
      if (finalFileHandle) {
        // Pre-supplied by manual record path (showSaveFilePicker was already shown)
        this.finalFileHandle = finalFileHandle;
        this.outputWritable  = await this.finalFileHandle.createWritable();
        console.log('[liveDownload] Output file opened for streaming');
      } else {
        // Auto-record path — create file now that we have the translated filename
        await this._openOutputFile(this.originalFilename);
      }

      // 7. Enqueue initial segments (resolve relative URIs against manifest URL)
      for (const seg of initialSegments) {
        const uri = seg.url || seg.uri;
        if (uri) {
          const resolvedUri = new URL(uri, this.url).href;
          this.seen.add(resolvedUri);
          this.pendingSegments.push({ ...seg, resolvedUri, retryCount: 0 });
          this.metrics.segmentsFound++;
        }
      }

      console.log(`[liveDownload] Started with ${this.metrics.segmentsFound} initial segments`);
      this.updateUI();

      // 8. Start duration timer and main loop
      this.durationTimer = setInterval(() => this.updateDuration(), 1000);
      this.runLoop();
    }

    /**
     * Main recording loop — polls manifest and drains segment queue in sequence.
     * Self-throttling: next iteration starts only after the current one finishes.
     */
    async runLoop() {
      console.log('[liveDownload] Starting main loop');

      while (this.active && !this.stopping) {
        if (this.isInRecoveryMode) {
          await sleep(1000);  // recovery polling handles everything
          continue;
        }

        try {
          await this.check();
          await this.processQueue();
        } catch (e) {
          console.error('[liveDownload] Loop error:', e);
        }

        if (this.active && !this.stopping) await sleep(POLL_INTERVAL);
      }

      console.log('[liveDownload] Main loop ended');
    }

    /**
     * Stop the recording, finalize the output file, and show the completion screen.
     */
    async stop() {
      if (this.stopping) return;
      this.stopping = true;
      this.active   = false;

      console.log('[liveDownload] Stopping...');
      this.stopRecoveryPolling();

      if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }

      document.title = 'Finalizing recording...';
      const statusText = document.getElementById('live-status-text');
      if (statusText) statusText.textContent = 'FINALIZING...';

      // Wait for any in-flight check/download
      let waitCount = 0;
      while ((this.checkInFlight || this.downloadInFlight) && waitCount < 30) {
        await sleep(1000);
        waitCount++;
      }

      // Drain up to 10 remaining segments
      if (this.pendingSegments.length > 0) {
        console.log(`[liveDownload] Processing ${this.pendingSegments.length} remaining segments...`);
        const limit = Math.min(this.pendingSegments.length, 10);
        for (let i = 0; i < limit && this.pendingSegments.length > 0; i++) {
          this.downloadInFlight = true;
          await this.downloadSegment(this.pendingSegments.shift());
          this.downloadInFlight = false;
        }
        if (this.pendingSegments.length > 0) {
          console.log(`[liveDownload] Skipped ${this.pendingSegments.length} segments (stopping)`);
          this.metrics.segmentsFailed += this.pendingSegments.length;
        }
      }

      // Close output file
      if (this.outputWritable) {
        try {
          await this.outputWritable.close();
          console.log('[liveDownload] Output file closed');
          if (this.usingOPFS && this.finalFileHandle) await this.triggerOPFSDownload();
        } catch (e) {
          console.error('[liveDownload] Error closing output file:', e);
        }
      }

      await this.unregisterRecording();
      this.logMetrics();
      this.updateUI();
      this.showCompletionScreen();

      document.body.dataset.mode = 'done';
      await this.checkReenterWaiting();
    }

    /** Prompt user before stopping. */
    async userStop() {
      if (!confirm('Stop recording and save what has been recorded so far?')) return;
      console.log('[liveDownload] User requested stop');
      await this.stop();
    }

    // ── Recovery ──────────────────────────────────────────────────────────────

    /**
     * Enter recovery mode: save the current file, clear state, start polling
     * the broadcaster's page for a new manifest URL.
     */
    async enterRecoveryMode(reason) {
      if (this.isInRecoveryMode) return;

      console.log(`[liveDownload] === ENTERING RECOVERY MODE ===`);
      console.log(`[liveDownload] Reason: ${reason}`);

      this.isInRecoveryMode    = true;
      this.isWaitingForStream  = false;
      this.recoveryStartTime   = Date.now();

      this.updateHeaderState('recovery');
      this.showNotification(`Stream interrupted: ${reason}. Searching for new stream...`, 'warning');

      await this.saveCurrentRecording();

      console.log(`[liveDownload] Next recording will be: ${this.originalFilenameBase}-[timestamp].ts`);

      this.seen.clear();
      this.pendingSegments            = [];
      this.consecutiveManifestErrors  = 0;

      this.startRecoveryPolling();
    }

    /**
     * Flush remaining segments, close the output file, and verify it was written.
     * Called before creating a new recovery file.
     */
    async saveCurrentRecording() {
      const filename   = this.finalFileHandle?.name || this.originalFilename + '.ts';
      const fileSizeMB = (this.metrics.currentFileBytesDownloaded / (1024 * 1024)).toFixed(2);

      console.log(`[liveDownload] Saving current recording: ${filename}`);
      console.log(`[liveDownload] Current file: ${this.metrics.currentFileBytesDownloaded} bytes (${fileSizeMB} MB)`);
      console.log(`[liveDownload] Session total: ${(this.metrics.bytesDownloaded / (1024 * 1024)).toFixed(2)} MB`);

      // Wait for any in-flight download
      let n = 0;
      while (this.downloadInFlight && n++ < 10) await sleep(500);

      // Flush up to 5 remaining segments
      const remaining = Math.min(this.pendingSegments.length, 5);
      console.log(`[liveDownload] Flushing ${remaining} remaining segments...`);
      for (let i = 0; i < remaining && this.pendingSegments.length > 0; i++) {
        this.downloadInFlight = true;
        await this.downloadSegment(this.pendingSegments.shift());
        this.downloadInFlight = false;
      }

      if (!this.outputWritable) {
        console.error('[liveDownload] ✗ No output writable — file may not have been created');
        return;
      }

      try {
        await this.outputWritable.close();
        this.outputWritable = null;
        console.log(`[liveDownload] ✓ Writable closed: ${filename}`);

        // Allow Chrome time to rename .crswap → .ts
        const delayMs = Math.min(2000 + Math.floor(parseFloat(fileSizeMB) / 100) * 500, 5000);
        console.log(`[liveDownload] Waiting ${delayMs}ms for file finalization...`);
        await sleep(delayMs);

        if (this.finalFileHandle) {
          try {
            const file = await this.finalFileHandle.getFile();
            console.log(`[liveDownload] ✓ Verified on disk: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
            if (file.size === 0) console.error('[liveDownload] ⚠ WARNING: File is 0 bytes!');
          } catch (e) {
            console.error('[liveDownload] Could not verify file:', e);
          }
          if (this.usingOPFS) await this.triggerOPFSDownload();
          this.finalFileHandle = null;
        }

        console.log(`[liveDownload] ✓ File finalized: ${filename}`);
      } catch (e) {
        console.error('[liveDownload] ✗ Error closing file:', e);
        this.outputWritable  = null;
        this.finalFileHandle = null;
      }

      this.metrics.currentFileBytesDownloaded = 0;
    }

    startRecoveryPolling() {
      console.log(`[liveDownload] Starting recovery polling (every ${this.recoveryPollInterval} min)`);
      this.pollForNewManifest();
      this.recoveryPollTimer = setInterval(
        () => this.pollForNewManifest(),
        this.recoveryPollInterval * 60 * 1000
      );
    }

    stopRecoveryPolling() {
      if (this.recoveryPollTimer) { clearInterval(this.recoveryPollTimer); this.recoveryPollTimer = null; }
    }

    /**
     * Open or refresh the broadcaster's page in a background tab, detect a new
     * m3u8 stream, and resume recording when one is found.
     */
    async pollForNewManifest() {
      console.log('[liveDownload] Polling for new manifest...');

      // Enforce 10-minute recovery timeout
      if (this.recoveryStartTime) {
        const elapsedMin = (Date.now() - this.recoveryStartTime) / 60_000;
        if (elapsedMin >= 10) {
          console.log(`[liveDownload] ⏱️ Recovery timeout: ${elapsedMin.toFixed(1)} min — closing window`);
          this.stopRecoveryPolling();
          this.showNotification('Stream recovery timed out after 10 minutes. Recording ended.', 'error');
          setTimeout(async () => {
            try { await chrome.windows.remove((await chrome.windows.getCurrent()).id); } catch { }
          }, 3000);
          return;
        }
      }

      let monitoringTabId = this.tabId;
      let createdNewTab   = false;

      try {
        // Verify original tab still exists
        if (this.tabId) {
          try {
            await chrome.tabs.get(this.tabId);
            console.log('[liveDownload] Original monitoring tab still exists');
          } catch {
            console.log('[liveDownload] Original tab gone — creating new monitoring tab');
            monitoringTabId = null;
          }
        }

        if (!monitoringTabId) {
          console.log('[liveDownload] 🔄 Opening new monitoring tab:', this.pageUrl);

          try {
            const origin = new URL(this.pageUrl).origin + '/';
            await new Promise((res, rej) =>
              chrome.contentSettings.sound.set(
                { primaryPattern: origin + '*', setting: 'allow' },
                () => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
              )
            );
            console.log('[liveDownload] 🔊 Sound/autoplay allowed:', origin);
          } catch (e) {
            console.warn('[liveDownload] Could not set sound permission:', e.message);
          }

          const newTab    = await chrome.tabs.create({ url: this.pageUrl, active: false });
          monitoringTabId = newTab.id;
          createdNewTab   = true;

          console.log('[liveDownload] Waiting for page to load...');
          await sleep(4000);
          await _injectTabAutoplay(monitoringTabId);
          await sleep(4000);
          await _injectTabAutoplay(monitoringTabId);

        } else {
          console.log('[liveDownload] Refreshing existing monitoring tab');
          await chrome.tabs.reload(monitoringTabId);
          await sleep(6000);
          await _injectTabAutoplay(monitoringTabId);
          await sleep(4000);
        }

        console.log('[liveDownload] Checking for m3u8 streams...');
        const result = await chrome.scripting.executeScript({
          target: { tabId: monitoringTabId },
          func: () => {
            if (!self.storage?.size) return null;
            const streams = [];
            for (const [url] of self.storage) {
              if (url.includes('.m3u8')) streams.push({ url });
            }
            return streams;
          }
        });

        const streams = result[0]?.result;

        if (createdNewTab) {
          try { await chrome.tabs.remove(monitoringTabId); } catch { }
        }

        if (streams?.length > 0) {
          console.log(`[liveDownload] ✅ Found ${streams.length} stream(s) on page`);
          for (const stream of streams) {
            console.log('[liveDownload] Checking stream:', stream.url.substring(0, 80) + '...');
            if (await isLiveStream(stream.url)) {
              console.log('[liveDownload] ✅ Found live stream — resuming recording!');
              await this.resumeRecording(stream.url);
              return;
            }
          }
          console.log('[liveDownload] No live streams among detected URLs');
        } else {
          console.log('[liveDownload] No streams detected on page yet');
        }

        this._logNextRecoveryPoll();

      } catch (e) {
        console.error('[liveDownload] Error polling for manifest:', e);
        if (createdNewTab && monitoringTabId) {
          try { await chrome.tabs.remove(monitoringTabId); } catch { }
        }
        this._logNextRecoveryPoll();
      }
    }

    _logNextRecoveryPoll() {
      const next = new Date(Date.now() + this.recoveryPollInterval * 60_000);
      console.log(`[liveDownload] Next recovery poll at: ${next.toLocaleTimeString()}`);
    }

    /**
     * Resume recording with a newly discovered manifest URL.
     * Creates a new output file via _openOutputFile() — same path as start().
     */
    async resumeRecording(newManifestUrl) {
      console.log('[liveDownload] === RESUMING RECORDING ===');

      this.stopRecoveryPolling();
      this.isInRecoveryMode = false;

      const resolvedUrl = await resolveToMediaPlaylist(newManifestUrl);
      this.url = resolvedUrl;
      console.log('[liveDownload] New manifest URL:', resolvedUrl.substring(0, 80) + '...');

      // originalFilenameBase is already translated from start() — no re-translation needed
      const newFilename = createLiveFilename(this.originalFilenameBase);
      console.log(`[liveDownload] Creating recovery file: ${newFilename}`);

      try {
        await this._openOutputFile(newFilename);

        // Reset per-file metrics; keep cumulative bytesDownloaded
        this.metrics.segmentsFound              = 0;
        this.metrics.segmentsDownloaded         = 0;
        this.metrics.segmentsFailed             = 0;
        this.metrics.segmentsRetried            = 0;
        this.lastSuccessfulFetch                = Date.now();

        this.updateHeaderState('recording');
        this.showNotification(`Recording resumed: ${newFilename}`, 'success');

        const titleEl = document.getElementById('live-title');
        if (titleEl) titleEl.textContent = newFilename;
        document.title = `🔴 Recording: ${newFilename}`;

      } catch (e) {
        console.error('[liveDownload] Error creating recovery file:', e);
        this.showNotification('Failed to create new recording file', 'error');
        this.isInRecoveryMode = true;
        this.startRecoveryPolling();
      }
    }

    // ── Chrome API bridge ─────────────────────────────────────────────────────

    async registerRecording() {
      try {
        const params    = new URLSearchParams(window.location.search);
        const tabId     = parseInt(params.get('tabId'));
        const win       = await chrome.windows.getCurrent();
        this.recordingWindowId = win.id;

        await chrome.runtime.sendMessage({
          method:   'recording-register',
          windowId: win.id,
          tabId,
          title:    this.baseFilename,
          pageUrl:  this.pageUrl
        });
        console.log('[liveDownload] Registered recording window:', win.id);
      } catch (e) {
        console.warn('[liveDownload] Failed to register recording:', e);
      }
    }

    async unregisterRecording() {
      if (!this.recordingWindowId) return;
      try {
        await chrome.runtime.sendMessage({
          method:   'recording-unregister',
          windowId: this.recordingWindowId
        });
        console.log('[liveDownload] Unregistered recording window');
      } catch (e) {
        console.warn('[liveDownload] Failed to unregister recording:', e);
      }
    }

    async updateRecordingStats() {
      if (!this.recordingWindowId) return;
      try {
        const elapsed  = Math.floor((Date.now() - this.startTime) / 1000);
        const h        = Math.floor(elapsed / 3600);
        const m        = Math.floor((elapsed % 3600) / 60);
        const s        = elapsed % 60;
        const duration = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

        await chrome.runtime.sendMessage({
          method:   'recording-update',
          windowId: this.recordingWindowId,
          duration,
          segments: this.metrics.segmentsDownloaded
        });
      } catch {
        // Service worker may be restarting — ignore
      }
    }

    async checkReenterWaiting() {
      try {
        const params   = new URLSearchParams(window.location.search);
        const pageUrl  = params.get('href');

        if (pageUrl) {
          console.log('[liveDownload] Restoring WRU waiting state for:', pageUrl);
          await chrome.runtime.sendMessage({ method: 'wru-restoreWaiting', url: pageUrl });
        }

        const settings = await chrome.storage.local.get({ autoclose: false });
        if (settings.autoclose) {
          const tabId = parseInt(params.get('tabId'));
          if (tabId && pageUrl) {
            console.log('[liveDownload] Auto-close ON — re-entering waiting mode for tab', tabId);
            await chrome.runtime.sendMessage({ method: 'waitForStart-start', tabId, pageUrl });
            setTimeout(() => window.close(), 2000);
          }
        }
      } catch (e) {
        console.warn('[liveDownload] Error checking re-enter waiting:', e);
      }
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    // ── Reauth banner ─────────────────────────────────────────────────────────

    /**
     * Show the re-authorization banner when Chrome needs permission for the
     * configured recording directory after a restart.
     */
    _showReauthBanner() {
      const banner = document.getElementById('live-reauth-banner');
      if (!banner) return;

      // Fill in the directory name
      const nameEl = banner.querySelector('.reauth-dir-name');
      if (nameEl) nameEl.textContent = this._pendingReauthDir?.name || 'recording folder';

      banner.style.display = 'flex';

      const btn = document.getElementById('live-reauth-btn');
      if (btn) {
        btn.onclick = async () => {
          btn.disabled    = true;
          btn.textContent = 'Authorizing…';

          const granted = await this.reauthDirectory();
          if (granted) {
            this._hideReauthBanner();
            // Resume recording with the stored start args
            const { initialSegments, finalFileHandle } = this._pendingStartArgs || {};
            this._pendingStartArgs = null;
            await this.start(initialSegments || [], finalFileHandle || null);
          } else {
            btn.disabled    = false;
            btn.textContent = '📁 Authorize Recording Folder';
            this.showNotification('Authorization failed — please try again', 'error');
          }
        };
      }
    }

    _hideReauthBanner() {
      const banner = document.getElementById('live-reauth-banner');
      if (banner) banner.style.display = 'none';
    }

    // ── Main UI ───────────────────────────────────────────────────────────────

    showUI() {
      const dashboard = document.getElementById('live-dashboard');
      if (!dashboard) return;

      dashboard.style.display = 'flex';

      const titleEl = document.getElementById('live-title');
      if (titleEl) titleEl.textContent = this.baseFilename;
      document.title = `🔴 Recording: ${this.baseFilename}`;

      const sourceUrlEl = document.getElementById('live-source-url');
      if (sourceUrlEl) {
        if (this.pageUrl) {
          sourceUrlEl.href = this.pageUrl;
          try {
            const u = new URL(this.pageUrl);
            sourceUrlEl.textContent = u.hostname + u.pathname;
          } catch {
            sourceUrlEl.textContent = this.pageUrl.substring(0, 60) + (this.pageUrl.length > 60 ? '...' : '');
          }
        } else {
          sourceUrlEl.textContent = 'Not available';
          sourceUrlEl.removeAttribute('href');
        }
      }

      document.body.classList.add('live-recording-active');

      const stopBtn = document.getElementById('stop-recording');
      if (stopBtn) stopBtn.onclick = () => this.userStop();

      const closeBtn = document.getElementById('close-recording-window');
      if (closeBtn) closeBtn.onclick = () => window.close();

      this.registerRecording();
    }

    hideUI() {
      // Dashboard stays visible — completion screen replaces recording controls
    }

    updateHeaderState(state) {
      const header         = document.getElementById('live-header');
      const statusIcon     = document.getElementById('live-status-icon');
      const statusText     = document.getElementById('live-status-text');
      const networkWarning = document.getElementById('live-network-warning');

      if (!header) return;

      header.classList.remove('recording', 'waiting', 'complete', 'error', 'recovery');
      header.classList.add(state);

      const states = {
        recording: { icon: '🔴', text: 'LIVE RECORDING',        warning: false, title: `🔴 Recording: ${this.baseFilename}` },
        waiting:   { icon: '⏸️', text: 'WAITING FOR STREAM',    warning: true,  title: `⏸️ Waiting: ${this.baseFilename}`  },
        recovery:  { icon: '🔄', text: 'RECOVERY MODE',          warning: true,  title: `🔄 Recovery: ${this.baseFilename}` },
        complete:  { icon: '✅', text: 'RECORDING COMPLETE',     warning: false, title: `✅ Complete: ${this.baseFilename}` },
        error:     { icon: '❌', text: 'RECORDING STOPPED',      warning: false, title: `❌ Stopped: ${this.baseFilename}`  }
      };

      const cfg = states[state];
      if (!cfg) return;

      if (statusIcon)     statusIcon.textContent = cfg.icon;
      if (statusText)     statusText.textContent = cfg.text;
      if (networkWarning) networkWarning.style.display = cfg.warning ? 'flex' : 'none';
      document.title = cfg.title;
    }

    updateUI() {
      const el = id => document.getElementById(id);

      const segCount   = el('live-segment-count');
      const batchCount = el('live-batch-count');
      const mbEl       = el('live-mb-downloaded');
      const failsEl    = el('live-fails-display');
      const retriedCard  = el('live-retried-card');
      const retriedCount = el('live-retried-count');
      const manifestCard  = el('live-manifest-errors-card');
      const manifestCount = el('live-manifest-error-count');
      const errorCountEl  = el('live-error-count');
      const lastSuccessEl = el('live-last-success-time');

      if (segCount)   segCount.textContent   = this.metrics.segmentsDownloaded;
      if (batchCount) batchCount.textContent  = this.pendingSegments.length;

      const mbDownloaded = (this.metrics.currentFileBytesDownloaded / (1024 * 1024)).toFixed(1);
      if (mbEl) mbEl.textContent = `${mbDownloaded} MB`;

      if (failsEl) {
        const failed   = this.metrics.segmentsFailed;
        const total    = this.metrics.segmentsFound;
        const failRate = total > 0 ? Math.round((failed / total) * 100) : 0;
        failsEl.textContent = `${failed} / ${total} (${failRate}%)`;
        failsEl.classList.toggle('warning', failRate > 10);
      }

      if (retriedCard && retriedCount) {
        const show = this.metrics.segmentsRetried > 0;
        retriedCard.style.display  = show ? '' : 'none';
        if (show) retriedCount.textContent = this.metrics.segmentsRetried;
      }

      if (manifestCard && manifestCount) {
        const show = this.consecutiveManifestErrors > 0;
        manifestCard.style.display  = show ? '' : 'none';
        if (show) manifestCount.textContent = this.consecutiveManifestErrors;
      }

      if (errorCountEl) errorCountEl.textContent = this.consecutiveManifestErrors;

      if (lastSuccessEl && this.lastSuccessfulFetch) {
        const secs = Math.floor((Date.now() - this.lastSuccessfulFetch) / 1000);
        lastSuccessEl.textContent = secs < 5    ? 'just now'
          : secs < 60 ? `${secs} seconds ago`
          : `${Math.floor(secs / 60)} minute${Math.floor(secs / 60) > 1 ? 's' : ''} ago`;
      }
    }

    updateDuration() {
      const el = document.getElementById('live-duration');
      if (!el || !this.startTime) return;

      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

      if (elapsed % 5 === 0) this.updateRecordingStats();
    }

    showCompletionScreen() {
      this.updateHeaderState('complete');

      const stopBtn    = document.getElementById('stop-recording');
      const completion = document.getElementById('live-completion');
      const actions    = document.querySelector('.live-actions');

      if (stopBtn)    stopBtn.style.display    = 'none';
      if (actions)    actions.style.display    = 'none';
      if (completion) completion.style.display = 'block';

      // Wire donate button
      const donateBtn = document.getElementById('live-donate-btn');
      if (donateBtn) {
        donateBtn.addEventListener('click', () => {
          chrome.tabs.create({ url: 'https://www.savethechildren.org/savekids' });
        });
      }

      const fileInfo   = document.getElementById('live-file-info');
      if (fileInfo) {
        const mb      = (this.metrics.bytesDownloaded / (1024 * 1024)).toFixed(2);
        const dirName = this.directoryName || 'Downloads';

        fileInfo.textContent = this.usingOPFS
          ? `📄 ${this.baseFilename}.ts • ${mb} MB (saved to Downloads)`
          : `📄 ${dirName}/${this.baseFilename}.ts • ${mb} MB`;

        if (this.fileIncrement > 0) {
          const n = this.fileIncrement + 1;
          fileInfo.textContent += ` (${n} file${n > 1 ? 's' : ''} total)`;
        }
      }
    }

    showNotification(message, type = 'info') {
      const colors = { warning: '#f59e0b', error: '#ef4444', success: '#10b981', info: '#3b82f6' };
      const el     = document.createElement('div');
      el.textContent = message;
      el.style.cssText = `
        position:fixed;bottom:80px;right:20px;max-width:400px;padding:12px 16px;
        background:${colors[type] ?? colors.info};color:#fff;border-radius:8px;
        font-size:13px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.3);
        z-index:10001;animation:slideInRight 0.3s ease-out;
      `;
      document.body.appendChild(el);
      setTimeout(() => {
        el.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => el.remove(), 300);
      }, 5000);
    }

    logMetrics() {
      const m           = this.metrics;
      const successRate = m.segmentsFound > 0
        ? Math.round((m.segmentsDownloaded / m.segmentsFound) * 100)
        : 100;

      console.log('[liveDownload] === RECORDING METRICS ===');
      console.log(`[liveDownload]   Segments found:      ${m.segmentsFound}`);
      console.log(`[liveDownload]   Segments downloaded: ${m.segmentsDownloaded}`);
      console.log(`[liveDownload]   Segments failed:     ${m.segmentsFailed}`);
      console.log(`[liveDownload]   Segments retried:    ${m.segmentsRetried}`);
      console.log(`[liveDownload]   Success rate:        ${successRate}%`);
      console.log(`[liveDownload]   Data downloaded:     ${(m.bytesDownloaded / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`[liveDownload]   Seen set size:       ${this.seen.size}`);
      console.log(`[liveDownload]   File segments saved: ${this.fileIncrement + 1}`);
      console.log('[liveDownload] =========================');
    }

    // Convenience getter — kept for any callers that use it
    getCurrentFilename() { return this.originalFilename; }
  }

  // ─── Exports ────────────────────────────────────────────────────────────────

  window.LiveMonitor = LiveMonitor;
  window.LiveMonitor.isLiveStream           = isLiveStream;
  window.LiveMonitor.resolveToMediaPlaylist = resolveToMediaPlaylist;
  window.LiveMonitor.parseMasterPlaylist    = parseMasterPlaylist;

  console.log(`[liveDownload] Ready (v${VERSION})`);

})();
