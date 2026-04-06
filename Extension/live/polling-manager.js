/**
 * liveDownload - Polling Manager
 * WaitForStart system: tracks tabs waiting for a broadcast to start,
 * drives the clock-aligned alarm, and runs sequential URL polling.
 *
 * Sprint 1: Calls _saveMonitoringWindowIds() (from window-manager.js) after
 * every mutation to monitoringWindowIds so the set survives SW restarts.
 *
 * Depends on:
 *   recording-registry.js  (recordingWindows, isAlreadyRecording)
 *   window-manager.js       (monitoringWindowIds, _saveMonitoringWindowIds,
 *                            getMonitoringWindowBounds, openWithAutoRecord)
 */

'use strict';

// Runtime state: Map<tabId, {pageUrl, startedAt}>
// Not persisted — rebuilt on service worker restart at the next poll cycle.
const waitingTabs = new Map();

// Tabs that were stopped by an external action (deactivation or manual tab close)
// rather than by stream detection. Used by waitForStreamOrTimeout to distinguish
// a true abort from a stream-detected stop.
// handleStreamDetected does NOT add to this set — only handleWRUTabClosed does.
const externallyAbortedTabs = new Set();

// Prevent overlapping polling cycles
let isPollingInProgress = false;

const WAIT_DEFAULTS = {
  checkInterval:  15,   // minutes between polls
  initialWait:    15,   // seconds to let the player stabilise before auto-record
  maxTabs:        10,
  monitorTimeout: 45    // seconds to wait per URL during sequential polling
};

// ---------- Settings ----------

async function getWaitSettings() {
  const stored = await chrome.storage.local.get({
    'waitForStart_checkInterval':  WAIT_DEFAULTS.checkInterval,
    'waitForStart_initialWait':    WAIT_DEFAULTS.initialWait,
    'waitForStart_maxTabs':        WAIT_DEFAULTS.maxTabs,
    'waitForStart_monitorTimeout': WAIT_DEFAULTS.monitorTimeout
  });
  return {
    checkInterval:  stored['waitForStart_checkInterval'],
    initialWait:    stored['waitForStart_initialWait'],
    maxTabs:        stored['waitForStart_maxTabs'],
    monitorTimeout: stored['waitForStart_monitorTimeout']
  };
}

// ---------- Tab waiting CRUD ----------

async function startWaiting(tabId, pageUrl) {
  const settings = await getWaitSettings();
  if (waitingTabs.size >= settings.maxTabs) {
    console.warn(ts(), 'WaitForStart] Max waiting tabs reached:', settings.maxTabs);
    return { success: false, error: 'max_tabs_reached', maxTabs: settings.maxTabs };
  }
  waitingTabs.set(tabId, { pageUrl, startedAt: Date.now() });
  console.log(ts(), `WaitForStart] Started waiting for tab ${tabId}`);
  return { success: true };
}

async function stopWaiting(tabId) {
  if (waitingTabs.has(tabId)) {
    waitingTabs.delete(tabId);
    externallyAbortedTabs.delete(tabId);  // clean up either way
    console.log(ts(), `WaitForStart] Stopped waiting for tab ${tabId}`);
    return true;
  }
  return false;
}

function isWaiting(tabId) {
  return waitingTabs.has(tabId);
}

function getWaitingInfo(tabId) {
  return waitingTabs.get(tabId) || null;
}

async function getAllWaitingTabs() {
  const tabs = [];
  for (const [tabId, info] of waitingTabs) {
    let title = info.pageUrl;
    try {
      const tab = await chrome.tabs.get(tabId);
      title = tab.title || info.pageUrl;
    } catch (e) { /* tab may no longer exist */ }
    tabs.push({ tabId, title, pageUrl: info.pageUrl, startedAt: info.startedAt });
  }
  return { count: tabs.length, tabs };
}

// ---------- Clock-aligned alarm ----------

function getNextAlignedTime(intervalMinutes) {
  const now  = new Date();
  const mins = now.getMinutes();
  const nextAligned = Math.ceil((mins + 0.1) / intervalMinutes) * intervalMinutes;
  const target = new Date(now);
  target.setMinutes(nextAligned);
  target.setSeconds(0);
  target.setMilliseconds(0);
  return target.getTime();
}

async function initializePolling() {
  const settings        = await getWaitSettings();
  const intervalMinutes = settings.checkInterval || 15;

  await chrome.alarms.clear('pollStreams');

  const nextFireTime  = getNextAlignedTime(intervalMinutes);
  const delayMs       = nextFireTime - Date.now();
  const delayMinutes  = Math.max(0.1, delayMs / 60000);

  await chrome.alarms.create('pollStreams', {
    delayInMinutes:  delayMinutes,
    periodInMinutes: intervalMinutes
  });

  const nextFireDate = new Date(nextFireTime);
  console.log(ts(), `WRU] Polling initialized: every ${intervalMinutes} minutes`);
  console.log(ts(), `WRU] Next poll: ${nextFireDate.toLocaleTimeString()} (in ${Math.round(delayMinutes)} min)`);
}

async function updatePollingInterval(newIntervalMinutes) {
  await chrome.alarms.clear('pollStreams');
  const nextFireTime = getNextAlignedTime(newIntervalMinutes);
  const delayMs      = nextFireTime - Date.now();
  const delayMinutes = Math.max(0.1, delayMs / 60000);

  await chrome.alarms.create('pollStreams', {
    delayInMinutes:  delayMinutes,
    periodInMinutes: newIntervalMinutes
  });

  const nextFireDate = new Date(nextFireTime);
  console.log(ts(), `WRU] ✅ Polling interval updated to ${newIntervalMinutes} minutes`);
  console.log(ts(), `WRU] Next poll: ${nextFireDate.toLocaleTimeString()} (in ${Math.round(delayMinutes)} min)`);
}

// ---------- Sequential polling ----------

async function checkAllActiveURLs() {
  console.log(ts(), 'WRU] 🔔 Polling alarm fired — checking all active URLs SEQUENTIALLY');

  const settings = await chrome.storage.local.get('waitForStart_pollingSuspended');
  if (settings['waitForStart_pollingSuspended']) {
    console.log(ts(), 'WRU] 💤 Polling suspended by user, skipping this cycle');
    return;
  }

  if (isPollingInProgress) {
    console.log(ts(), 'WRU] ⏭️ Polling already in progress, skipping this cycle');
    return;
  }

  isPollingInProgress = true;
  try {
    const list       = await getWRUList();           // defined in wru-manager.js
    const activeURLs = list.filter(entry => !entry.inactive);

    if (activeURLs.length === 0) {
      console.log(ts(), 'WRU] No active URLs configured');
      return;
    }

    console.log(ts(), `WRU] Should be monitoring ${activeURLs.length} URLs`);

    await closeAllMonitoringWindows();

    const waitSettings   = await getWaitSettings();
    const timeoutPerURL  = waitSettings.monitorTimeout || 45;

    console.log(ts(), `WRU] Processing URLs sequentially with ${timeoutPerURL}s timeout per URL`);

    for (const entry of activeURLs) {
      await processOneURLSequentially(entry, timeoutPerURL);
    }

    console.log(ts(), `WRU] ✅ Sequential polling complete — now monitoring ${waitingTabs.size} windows`);
  } catch (e) {
    console.error('[WRU] ❌ Polling cycle failed:', e.message);
  } finally {
    isPollingInProgress = false;
  }
}

/**
 * Poll a single URL immediately without disturbing other active monitoring windows.
 * Called when a URL is just added or re-activated — we only want to check that one
 * URL rather than closing all windows and cycling through the entire list.
 *
 * If a full poll cycle is already running, this becomes a no-op (the URL will be
 * picked up naturally in the current or next full cycle).
 */
async function checkSingleURL(entry) {
  console.log(ts(), `WRU] 🔔 Immediate single-URL poll for: ${entry.url}`);

  const settings = await chrome.storage.local.get('waitForStart_pollingSuspended');
  if (settings['waitForStart_pollingSuspended']) {
    console.log(ts(), 'WRU] 💤 Polling suspended, skipping immediate poll');
    return;
  }

  if (isPollingInProgress) {
    console.log(ts(), `WRU] ⏭️ Full poll already in progress — ${entry.url} will be picked up naturally`);
    return;
  }

  isPollingInProgress = true;
  try {
    const waitSettings  = await getWaitSettings();
    const timeoutPerURL = waitSettings.monitorTimeout || 45;
    await processOneURLSequentially(entry, timeoutPerURL);
    console.log(ts(), `WRU] ✅ Single-URL poll complete for ${entry.url}`);
  } finally {
    isPollingInProgress = false;
  }
}

/**
 * Close all monitoring windows we created (tracked in monitoringWindowIds).
 * With session persistence, this now correctly closes orphaned windows
 * that were opened before the service worker restarted.
 */
async function closeAllMonitoringWindows() {
  console.log(ts(), 'WRU] 🧹 Closing all existing monitoring windows...');
  let closedCount = 0;

  for (const windowId of Array.from(monitoringWindowIds)) {
    try {
      await chrome.windows.remove(windowId);
      closedCount++;
      console.log(ts(), `WRU] 🧹 Closed monitoring window ${windowId}`);
    } catch (e) {
      // Window already closed — just remove from set
    }
    monitoringWindowIds.delete(windowId);
  }
  await _saveMonitoringWindowIds();  // Persist the now-empty set
  console.log(ts(), `WRU] 🧹 Closed ${closedCount} monitoring windows`);
}

/**
 * Grant sound/autoplay permission for a URL's origin via Chrome's contentSettings API.
 * Chrome's autoplay policy blocks HLS player initialization on sites that haven't been
 * granted "Sound: Allow" in site settings — this replicates what the user would set manually
 * at chrome://settings/content/siteDetails for the given origin.
 *
 * Must be called BEFORE opening the monitoring window so Chrome applies the setting
 * when the tab first loads.
 */
async function _allowAutoplay(url) {
  try {
    const origin = new URL(url).origin + '/';   // e.g. "https://example.com/"
    const pattern = origin + '*';
    await new Promise((resolve, reject) => {
      chrome.contentSettings.sound.set(
        { primaryPattern: pattern, setting: 'allow' },
        () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      );
    });
    console.log(ts(), `WRU] 🔊 Sound/autoplay allowed for ${origin}`);
  } catch (e) {
    console.warn(ts(), `WRU] ⚠️ Could not set sound permission for ${url}:`, e.message);
  }
}

/**
 * Inject player initialization clicks into a monitoring tab after page-load delays.
 * Acts as a belt-and-suspenders fallback in case the contentSettings grant above
 * didn't take effect in time, or the player needs an explicit nudge.
 *
 * Many streaming sites (e.g. SOOP/AfreecaTV) defer HLS source initialization until
 * a real user click on the player overlay — calling video.play() alone won't work
 * because the video element has no src yet. We dispatch real MouseEvents to trigger
 * the site's own click handlers, then call video.play() as a final fallback.
 */

function _injectAutoplay(tabId) {
  const delays = [4000, 8000, 14000];
  delays.forEach(delay => {
    setTimeout(async () => {
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            function fireClick(el) {
              ['pointerdown','mousedown','mouseup','click'].forEach(type => {
                el.dispatchEvent(new MouseEvent(type, {
                  bubbles: true, cancelable: true, view: window,
                  clientX: el.getBoundingClientRect().left + el.offsetWidth / 2,
                  clientY: el.getBoundingClientRect().top  + el.offsetHeight / 2
                }));
              });
            }

            // Strategy 1: known player overlay/stop-screen (SOOP/AfreecaTV)
            const stopScreen = document.querySelector('#stop_screen');
            if (stopScreen && stopScreen.offsetParent !== null) {
              fireClick(stopScreen); return 'stop-screen';
            }

            // Strategy 2: known player container
            const playerDiv = document.querySelector('#afreecatv_player');
            if (playerDiv) { fireClick(playerDiv); return 'player-div'; }

            // Strategy 3: any visible play button by class/text
            for (const el of document.querySelectorAll('button, [role="button"], a, div')) {
              if (!el.offsetParent) continue; // skip hidden elements
              const t = el.textContent?.trim().toLowerCase() || '';
              const c = el.className?.toLowerCase() || '';
              const ar = el.getAttribute('aria-label')?.toLowerCase() || '';
              if (c.includes('btn_play') || c.includes('play-btn') || c.includes('play_btn') ||
                  ar.includes('play') || t === 'play' || t === '재생') {
                fireClick(el); return 'play-button:' + (el.className || el.id);
              }
            }

            // Strategy 4: click centre of video element — triggers site's click handler
            const video = document.querySelector('video');
            if (video) {
              fireClick(video);
              // Also try direct play() in case src is already set
              if (video.paused && video.src) {
                video.muted = false;
                const p = video.play();
                if (p) p.catch(() => { video.muted = true; video.play().catch(() => {}); });
              }
              return 'video-click';
            }

            // Strategy 5: click centre of document body as last resort
            const body = document.body;
            if (body) { fireClick(body); return 'body-click'; }

            return 'no-element-found';
          }
        });
        const method = result?.[0]?.result;
        if (method && method !== 'no-element-found') {
          console.log(ts(), `WRU] 🎬 Autoplay injected (tab ${tabId}, delay ${delay}ms): ${method}`);
        }
      } catch (e) {
        // Tab may have been closed before this fires — ignore
      }
    }, delay);
  });
}

/**
 * Open a window for one URL, wait for stream detection or timeout, then close if no stream.
 */
async function processOneURLSequentially(entry, timeoutSeconds) {
  // Normalize SOOP domain: .co.kr redirects to play-origin.sooplive.com which has
  // stricter CORS policies. Using .com directly avoids the redirect and keeps
  // the player on play.sooplive.com where CORS headers are correct.
  const resolvedUrl = entry.url.replace('sooplive.co.kr', 'sooplive.com');

  console.log(ts(), `WRU] 📡 Processing: ${resolvedUrl} (timeout: ${timeoutSeconds}s)`);

  // Skip if already recording this broadcaster
  const normalizedUrl = resolvedUrl.endsWith('/') ? resolvedUrl : resolvedUrl + '/';
  const baseUrl       = normalizedUrl.match(/(https?:\/\/[^\/]+\/[^\/]+\/)/)?.[1];

  console.log(ts(), `WRU] Skip check: baseUrl="${baseUrl}", recordingWindows.size=${recordingWindows.size}`);

  if (baseUrl && isAlreadyRecording(baseUrl)) {
    console.log(ts(), `WRU] ⚡ Already recording ${baseUrl}, skipping monitoring window`);
    return;
  }

  let window = null;
  let tabId  = null;

  try {
    // Grant sound/autoplay permission before the tab loads.
    // Chrome's autoplay policy can block HLS player initialization on any site
    // that hasn't been granted "Sound: Allow" in site settings.
    await _allowAutoplay(resolvedUrl);

    const bounds = await getMonitoringWindowBounds();

    try {
      if (_boundsRejected) {
        // Already know bounds are invalid (RDS disconnected) — skip straight to fallback
        window = await chrome.windows.create({
          url: resolvedUrl, type: 'normal', focused: true, state: 'normal'
        });
      } else {
        window = await chrome.windows.create({
          url:     resolvedUrl,
          width:   bounds.width,
          height:  bounds.height,
          left:    bounds.left,
          top:     bounds.top,
          type:    'normal',
          focused: true,
          state:   'normal'
        });
        _boundsRejected = false;  // success — clear any stale rejection state
      }
    } catch (boundsError) {
      if (!_boundsRejected) {
        // First failure — log once, then cache the state
        console.warn(ts(), `WRU] ⚠️ Window bounds rejected (${boundsError.message}) — switching to default positioning`);
        _boundsRejected = true;
      }
      window = await chrome.windows.create({
        url: resolvedUrl, type: 'normal', focused: true, state: 'normal'
      });
    }

    monitoringWindowIds.add(window.id);
    await _saveMonitoringWindowIds();  // ← Persist immediately after opening

    const tabs = await chrome.tabs.query({ windowId: window.id });
    if (tabs.length === 0) throw new Error('No tab in created window');

    tabId = tabs[0].id;
    console.log(ts(), `WRU] ✅ Opened monitoring window ${window.id}, tab ${tabId}`);

    // Inject video.play() after page load as belt-and-suspenders fallback.
    // Fire-and-forget: doesn't block waitForStreamOrTimeout.
    _injectAutoplay(tabId);


    await startWaiting(tabId, resolvedUrl);

    const result = await waitForStreamOrTimeout(tabId, timeoutSeconds);

    if (result === 'stream_detected') {
      console.log(ts(), `WRU] ✅ Stream detected for ${resolvedUrl}, auto-record triggered`);
      // Keep the window open — openWithAutoRecord will close the tab when recording starts
    } else if (result === 'aborted') {
      console.log(ts(), `WRU] ⏹️ Monitoring aborted for ${resolvedUrl} (deactivated or closed externally)`);
      // Close the monitoring window — it may still be open if aborted via deactivateWRU
      // (as opposed to the tab being closed by the user, where the window is already gone).
      try {
        await chrome.windows.remove(window.id);
        console.log(ts(), `WRU] 🗑️ Closed monitoring window ${window.id} (aborted)`);
      } catch (e) {
        // Window already closed (e.g. user closed it manually) — that's fine
      }
      monitoringWindowIds.delete(window.id);
      await _saveMonitoringWindowIds();
    } else {
      console.log(ts(), `WRU] ⏱️ Timeout (${timeoutSeconds}s) — no stream detected for ${resolvedUrl}`);
      try {
        await chrome.windows.remove(window.id);
        console.log(ts(), `WRU] 🗑️ Closed monitoring window ${window.id}`);
      } catch (e) {
        console.warn(ts(), `WRU] Could not close window ${window.id}:`, e.message);
      }
      monitoringWindowIds.delete(window.id);
      await _saveMonitoringWindowIds();  // ← Persist after removing
      await stopWaiting(tabId);
    }
  } catch (e) {
    console.error(`[WRU] ❌ Error processing ${resolvedUrl}:`, e);
    if (window) {
      try { await chrome.windows.remove(window.id); } catch (_) {}
      monitoringWindowIds.delete(window.id);
      await _saveMonitoringWindowIds();  // ← Persist after error cleanup
    }
    if (tabId) await stopWaiting(tabId);
  }
}

/** Poll every 2 s until stream is detected or timeout expires. */
async function waitForStreamOrTimeout(tabId, timeoutSeconds) {
  const startTime        = Date.now();
  const checkIntervalMs  = 2000;

  while (true) {
    // Explicitly aborted by deactivation — not stream detection
    if (externallyAbortedTabs.has(tabId)) return 'aborted';

    // Stream confirmed and recording window registered
    if (isRecordingStartedForTab(tabId)) return 'stream_detected';

    // stopWaiting() was called by handleStreamDetected (stream confirmed, recording window
    // opening in progress but not yet registered). Exit immediately with success so the
    // 30s wall timer doesn't fire a misleading "no stream detected" log while recording starts.
    if (!waitingTabs.has(tabId)) return 'stream_detected';

    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      // Tab closed — check if it was an external abort or stream detection
      return externallyAbortedTabs.has(tabId) ? 'aborted' : 'stream_detected';
    }

    if ((Date.now() - startTime) / 1000 >= timeoutSeconds) return 'timeout';

    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }
}

function isRecordingStartedForTab(tabId) {
  for (const [, info] of recordingWindows) {   // recordingWindows from recording-registry.js
    if (info.tabId === tabId) return true;
  }
  return false;
}

// ---------- Stream detected → trigger auto-record ----------

// Per-tab flag: prevents duplicate openWithAutoRecord calls when badge()
// fires rapidly (multiple HLS segment requests detected in quick succession).
const handlingStreamDetected = new Set();

async function handleStreamDetected(tabId, streamCount) {
  if (!waitingTabs.has(tabId)) return;
  if (handlingStreamDetected.has(tabId)) return;  // already in flight for this tab
  handlingStreamDetected.add(tabId);

  const settings = await getWaitSettings();
  console.log(ts(), `WaitForStart] Stream detected on tab ${tabId}! Waiting ${settings.initialWait}s for player to stabilise...`);

  setTimeout(async () => {
    if (!waitingTabs.has(tabId)) {
      console.log(ts(), `WaitForStart] Tab ${tabId} no longer waiting, aborting`);
      handlingStreamDetected.delete(tabId);
      return;
    }

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => self.storage ? self.storage.size : 0
      });
      const currentCount = result[0]?.result || 0;
      console.log(ts(), `WaitForStart] Stream count for tab ${tabId}: ${currentCount}`);

      if (currentCount > 0) {
        console.log(ts(), `WaitForStart] Confirmed ${currentCount} streams, triggering auto-record`);
        await stopWaiting(tabId);

        const tab = await chrome.tabs.get(tabId);
        await openWithAutoRecord(tab);   // from window-manager.js

        // Poll for recording confirmation (up to 30 s)
        const maxAttempts  = 15;
        const pollInterval = 2000;
        let recordingWindowId = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          for (const [windowId, info] of recordingWindows) {
            if (info.tabId === tabId) {
              recordingWindowId = windowId;
              break;
            }
          }

          if (recordingWindowId) {
            console.log(ts(), `WaitForStart] ✅ Recording confirmed (window ${recordingWindowId}), closing tab ${tabId}`);
            try { await chrome.tabs.remove(tabId); } catch (e) {
              console.log(ts(), `WaitForStart] Could not close tab ${tabId}:`, e.message);
            }
            break;
          }

          if ((attempt + 1) % 5 === 0 || attempt === maxAttempts - 1) {
            console.log(ts(), `WaitForStart] Attempt ${attempt + 1}/${maxAttempts}: no recording registered yet...`);
          }
        }

        if (!recordingWindowId) {
          console.log(ts(), `WaitForStart] ⚠️ No recording after ${maxAttempts * 2}s, keeping tab ${tabId} open`);
        }
      } else {
        console.log(ts(), `WaitForStart] Streams disappeared, continuing to wait`);
        handlingStreamDetected.delete(tabId);  // allow retry if streams reappear
      }
    } catch (e) {
      console.error(`[WaitForStart] Error during auto-record:`, e);
      handlingStreamDetected.delete(tabId);
    }
  }, settings.initialWait * 1000);
}
