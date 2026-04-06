/**
 * liveDownload - Main download orchestrator
 * Routes between:
 *   - Live streams → LiveMonitor (live-integration.js)
 *   - VOD/HLS      → VodDownloader (vod-downloader.js)
 *
 * Flow:
 *   1. parse() resolves M3U8/MPD URL → segment list
 *   2. isLiveStream() checks for #EXT-X-ENDLIST
 *   3. Route accordingly
 *
 * Globals expected on window:
 *   parse           (parse.js)
 *   helper          (helper.js)
 *   VodDownloader   (vod-downloader.js)
 *   LiveMonitor     (live-integration.js)
 *   addEntries      (build.js)
 *   network         (network/core.js)
 *   extract         (extract.js)
 */

'use strict';

/* global parse, helper, VodDownloader, network, extract, addEntries */

const args     = new URLSearchParams(location.search);
const tabId    = Number(args.get('tabId'));
const progress = document.getElementById('current-progress');

// ─── Stream entry population (uses extract + build) ─────────────────────────────

const pageTitle = args.get('title') || args.get('href') || '';
document.title = pageTitle ? `Downloading From: ${pageTitle}` : 'liveDownload';
Promise.all([
  extract.storage(tabId),
  extract.performance(tabId),
  extract.player(tabId)
]).then(async ([storageEntries, performanceEntries, playerEntries]) => {
  const entries = new Map();

  if (args.get('extra') === 'true') {
    try {
      const links = await new Promise(resolve =>
        chrome.runtime.sendMessage({ method: 'get-extra', tabId }, resolve)
      );
      for (const url of links) entries.set(url, { url });
    } catch (e) { console.error(e); }
  }

  try { for (const e of (playerEntries     || [])) entries.set(e.url, e); } catch (_) {}
  try { for (const e of (performanceEntries || [])) entries.set(e.url, e); } catch (_) {}
  try { for (const e of (storageEntries    || [])) entries.set(e.url, e); } catch (_) {}

  const append = args.get('append');
  if (append && !entries.has(append)) entries.set(append, { url: append });

  let forbiddens = 0;
  const blocked  = await network.blocked();
  for (const [stream, entry] of entries) {
    entry.blocked = blocked({ host: args.get('href'), stream });
    if (entry.blocked.value) forbiddens++;
  }

  await addEntries(entries);

  document.getElementById('forbiddens').textContent = forbiddens;
  if (forbiddens) document.body.classList.add('forbidden');
}).catch(e => {
  console.error('[liveDownload] Entry population failed:', e);
});

// ─── Error display ────────────────────────────────────────────────────────────

const showError = e => {
  console.warn('[liveDownload] Download error:', e);
  document.title = e?.message || 'Download error';
  document.body.dataset.mode = 'error';
};

// ─── Core download dispatcher ─────────────────────────────────────────────────

const download = async (segments, file, codec = '') => {

  // ── Live stream? Route to LiveMonitor ──
  const manifestUrl = segments[0]?.base || segments[0]?.resolvedUri;
  if (manifestUrl && window.LiveMonitor) {
    try {
      const isLive = await window.LiveMonitor.isLiveStream(manifestUrl);
      if (isLive) {
        console.log('[liveDownload] Live stream detected → LiveMonitor');
        const baseFilename = file.name.replace(/\.[^.]+$/, '');
        const monitor = new window.LiveMonitor(manifestUrl, baseFilename, codec);
        return await monitor.start(segments, file);
      }
    } catch (e) {
      console.warn('[liveDownload] Live detection failed, falling through to VOD:', e.message);
    }
  }

  // ── VOD download via VodDownloader ──
  document.body.dataset.mode = 'vod-download';
  progress.value = 0;

  // ── Show VOD dashboard ──
  const vodDash     = document.getElementById('vod-dashboard');
  const vodTitleEl  = document.getElementById('vod-title');
  const vodDuration = document.getElementById('vod-duration');
  const vodMB       = document.getElementById('vod-mb-downloaded');
  const vodSegs     = document.getElementById('vod-segment-count');
  const vodFails    = document.getElementById('vod-fails-display');
  const vodThreads  = document.getElementById('vod-threads');

  if (vodDash) {
    vodDash.style.display = '';
    if (vodTitleEl) vodTitleEl.textContent = file?.name || '';
  }

  // Handle multiple timelines (ads etc.)
  const timelines = {};
  for (const seg of segments) {
    timelines[seg.timeline] = timelines[seg.timeline] || [];
    timelines[seg.timeline].push(seg);
  }
  const timingObjects = Object.entries(timelines);

  if (timingObjects.length > 1) {
    let suggested = 0, largest = 0;
    for (const [id, a] of timingObjects) {
      if (largest < a.length) { suggested = id; largest = a.length; }
    }
    const msg = `This M3U8 file contains ${timingObjects.length} timelines (short ones are usually ads). ` +
      `Select the timeline to download, or download each separately.\n\n` +
      timingObjects.map(([id, a]) => `${id} (${a.length} segments)`).join('\n');

    const selected = await self.prompt(msg, {
      ok:    'Select Timeline',
      extra: ['Download Each Separately', 'Ignore Timelines'],
      no:    'Cancel',
      value: suggested
    }, true);

    if (selected === 'extra-0') {
      const jobs = timingObjects.map(([id, segs]) => ({
        name:     file.name.replace(/\.(?=[^.]+$)/, '-' + id + '.'),
        segments: segs
      }));
      try { file.remove(); } catch (_) {}
      return self.batch(jobs, codec);
    } else if (selected !== 'extra-1') {
      segments = timelines[selected];
    }
  }
  if (!Array.isArray(segments)) throw new Error('UNKNOWN_TIMELINE');

  // Deduplicate segments (fMP4 can repeat same URI)
  const seen = new Set();
  segments = segments.filter(seg => {
    if (seen.has(seg.uri)) return false;
    seen.add(seg.uri);
    return true;
  });

  // ── VodDownloader ──
  const { concurrency, threads } = await chrome.storage.local.get({ concurrency: 3, threads: 3 });
  const con = concurrency || threads || 3;
  const total = segments.length;
  const vodStartTime = Date.now();
  let failedSegments = 0;

  if (vodThreads) vodThreads.textContent = con;
  if (vodSegs)    vodSegs.textContent    = `0 / ${total}`;

  const startTimer = setInterval(() => {
    // Duration
    const elapsed = Math.floor((Date.now() - vodStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    if (vodDuration) vodDuration.textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    // MB downloaded
    const mb = (downloader._bytesLoaded / (1024 * 1024)).toFixed(1);
    if (vodMB) vodMB.textContent = `${mb} MB`;

    // Segments
    if (vodSegs) vodSegs.textContent = `${completedSegments} / ${total}`;

    // Fails
    if (vodFails) vodFails.textContent = failedSegments > 0
      ? `${failedSegments} / ${total} (${Math.round(failedSegments/total*100)}%)`
      : '0';

    // Title bar progress
    const pct = total > 1 ? (completedSegments / total * 100).toFixed(1) : null;
    document.title = pct
      ? `${pct}% — Downloading From: ${vodTitleEl?.textContent || ''}`
      : `${mb} MB downloaded...`;
    if (self.aFile) document.title += ` [Job ${self.aFile.stat.index}/${self.aFile.stat.total}]`;

    // Legacy progress bar (hidden but kept for compat)
    progress.value = completedSegments;
    progress.max   = total;
  }, 750);

  let completedSegments = 0;
  const downloader = new VodDownloader({
    concurrency: con,
    onProgress:  (done, _total) => { completedSegments = done; },
    onError:     (err, url) => {
      failedSegments++;
      return self.prompt(
        `Segment fetch failed (${err.message}):\n\n${url}\n\nPaste a replacement URL to retry, or cancel to stop.`,
        { ok: 'Retry', no: 'Cancel', value: url }, true
      ).then(v => v || null).catch(() => null);
    }
  });

  try {
    await downloader.download(segments, file);
    clearInterval(startTimer);

    // ── Completion ──
    const totalMB = (downloader._bytesLoaded / (1024 * 1024)).toFixed(1);
    const elapsed = Math.floor((Date.now() - vodStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const durationStr = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    // Final stat update
    if (vodDuration) vodDuration.textContent = durationStr;
    if (vodMB)       vodMB.textContent       = `${totalMB} MB`;
    if (vodSegs)     vodSegs.textContent     = `${total} / ${total}`;

    // Switch header to green complete state
    const vodHeader = document.getElementById('vod-header');
    if (vodHeader) {
      vodHeader.classList.remove('vod');
      vodHeader.classList.add('vod-complete');
    }
    const vodStatusIcon = document.getElementById('vod-status-icon');
    const vodStatusText = document.getElementById('vod-status-text');
    if (vodStatusIcon) vodStatusIcon.textContent = '✅';
    if (vodStatusText) vodStatusText.textContent = 'VOD DOWNLOAD COMPLETE';

    // Show completion panel
    const vodCompletion = document.getElementById('vod-completion');
    const vodFileInfo   = document.getElementById('vod-file-info');
    if (vodFileInfo) vodFileInfo.textContent = `${file?.name || 'file'} — ${totalMB} MB in ${durationStr}`;
    if (vodCompletion) vodCompletion.style.display = '';

    document.title = 'VOD Download Done';
    if ('download' in file) file.download(file.name); // Firefox

    document.body.dataset.mode = 'done';

    // Wire donate button
    const donateBtn = document.getElementById('vod-donate-btn');
    if (donateBtn) {
      donateBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://www.savethechildren.org/savekids' });
      });
    }
  } catch (e) {
    showError(e);
  }
  clearInterval(startTimer);
};

// ─── Submit handler (user clicks Download on a detected stream) ───────────────

const events = { before: new Set(), after: new Set() };

document.getElementById('hrefs').onsubmit = async e => {
  e.preventDefault();
  const div    = e.submitter.closest('label');
  const button = div.querySelector('input[type="submit"]');

  document.body.dataset.mode = 'prepare';

  try {
    div.dataset.active = true;

    const opts = helper.options(div);

    let file = self.aFile;
    if (!file) {
      const savedDir = window.getRootDirectory?.();
      if (savedDir) opts.startIn = savedDir;

      try {
        file = await window.showSaveFilePicker(opts);
      } catch (e) {
        // Strip illegal chars and retry (Windows/macOS/Linux safe filenames)
        if (e instanceof TypeError) {
          try {
            opts.suggestedName = opts.suggestedName?.replace(/[\\/:*?"<>|\0]|^[\s.]+|[\s.]+$|[~`!@#$%^&+={}[\];,]/g, '_');
            file = await window.showSaveFilePicker(opts);
          } catch (e2) {
            if (e2 instanceof TypeError) {
              delete opts.suggestedName;
              file = await window.showSaveFilePicker(opts);
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    }

    button.value = 'Processing...';

    for (const cb of events.before) await cb(div.entry);

    if (div.entry instanceof File) {
      await new Promise((resolve, reject) => {
        document.title = 'Parsing M3U8 manifest...';
        document.body.dataset.mode = 'parse';
        const reader = new FileReader();
        reader.onload = () => parse(reader.result, file, undefined, undefined, (segments, file, codec) => {
          document.title = 'Downloading ' + segments[0].base;
          return download(segments, file, codec);
        }).then(resolve, reject);
        reader.readAsText(div.entry, 'utf-8');
      });
    } else {
      if (helper.downloadable(div)) {
        document.title = 'Downloading ' + div.entry.url;
        await download([{ uri: div.entry.url }], file);
      } else {
        document.title = 'Parsing M3U8 manifest...';
        document.body.dataset.mode = 'parse';
        await parse(div.entry.url, file, undefined, undefined, (segments, file, codec) => {
          document.title = 'Downloading ' + segments[0].base;
          return download(segments, file, codec);
        });
      }
    }

    div.classList.remove('error');
    div.classList.add('done');
  } catch (e) {
    div.classList.remove('done');
    div.classList.add('error');
    showError(e);
  }

  for (const cb of events.after) {
    cb(
      document.body.dataset.mode === 'done',
      'aFile' in self ? self.aFile.stat.index === self.aFile.stat.total : true
    );
  }

  button.value = 'Download';
  div.dataset.active = false;
};
