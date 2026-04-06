/**
 * liveDownload - Window Manager
 * Handles creation of monitoring windows and the liveDownload recording window.
 * Tracks which windows WE created so we never accidentally close the user's windows.
 *
 * Sprint 1: monitoringWindowIds is persisted to chrome.storage.session so the
 * service worker can close orphaned monitoring windows after a sleep/restart.
 *
 * Depends on: recording-registry.js (isAlreadyRecording)
 */

'use strict';

// In-memory Set — kept in sync with chrome.storage.session after every mutation.
const monitoringWindowIds = new Set();

// Cache whether Chrome is currently rejecting explicit bounds (RDS disconnected).
// Set to true on first rejection, cleared when bounds succeed again.
// Prevents log spam during RDS sessions where every poll would otherwise warn.
let _boundsRejected = false;

// ---------- Session storage helpers ----------

async function _saveMonitoringWindowIds() {
  try {
    await chrome.storage.session.set({ monitoringWindowIds: Array.from(monitoringWindowIds) });
  } catch (e) {
    console.warn(ts(), 'WRU] Could not save monitoringWindowIds to session:', e.message);
  }
}

/**
 * Called once at service worker startup.
 * After restoration, the next poll cycle will call closeAllMonitoringWindows()
 * which will properly close any orphaned monitoring windows.
 */
async function loadMonitoringWindowIdsFromSession() {
  try {
    const data = await chrome.storage.session.get('monitoringWindowIds');
    const arr = data.monitoringWindowIds || [];
    for (const id of arr) monitoringWindowIds.add(id);
    if (arr.length > 0) {
      console.log(ts(), `WRU] ✅ Restored ${arr.length} monitoring window ID(s) from session`);
    }
  } catch (e) {
    console.warn(ts(), 'WRU] Could not restore monitoringWindowIds from session:', e.message);
  }
}

// ---------- Window positioning ----------

/**
 * Get safe window bounds for monitoring windows.
 * Positions at bottom-left to avoid notification area on bottom-right.
 * Falls back to a safe default if display info is unavailable or stale.
 */
async function getMonitoringWindowBounds() {
  const winW = 540;
  const winH = 405;
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find(d => d.isPrimary) || displays[0];
    if (primary && primary.bounds) {
      const screenW = primary.bounds.width;
      const screenH = primary.bounds.height;
      const left = 10;
      const top = screenH - winH - 10;
      // Valid display info — if we were in fallback mode, log the recovery once
      if (_boundsRejected) {
        console.log(ts(), 'WRU] 🖥️ Display info valid again — resuming calculated window positioning');
        _boundsRejected = false;
      }
      console.log(ts(), `WRU] 🖥️ Display: ${screenW}x${screenH} → window: ${winW}x${winH} at (${left}, ${top})`);
      return { width: winW, height: winH, left, top };
    }
  } catch (e) {
    console.warn(ts(), 'WRU] Could not get display info, using fallback bounds:', e.message);
  }
  return { width: winW, height: winH, left: 50, top: 50 };
}

// ---------- Window creation ----------

/**
 * Open a monitoring window for a URL and track its ID.
 * @param {string} url
 * @param {boolean} [focused=false]
 * @returns {Promise<Tab>} The tab inside the created window
 */
async function openMonitoringWindow(url, focused = false) {
  console.log(ts(), `WRU] Opening monitoring window for ${url} (focused: ${focused})`);
  try {
    const newWindow = await chrome.windows.create({
      url,
      type: 'normal',
      focused,
      state: 'normal'
    });
    monitoringWindowIds.add(newWindow.id);
    await _saveMonitoringWindowIds();
    const tabs = await chrome.tabs.query({ windowId: newWindow.id });
    if (tabs.length > 0) {
      console.log(ts(), `WRU] ✅ Opened monitoring window ${newWindow.id}, tab ${tabs[0].id} for ${url}`);
      return tabs[0];
    }
    throw new Error('No tab in created window');
  } catch (e) {
    console.error(`[WRU] ❌ Failed to open monitoring window:`, e);
    throw e;
  }
}

/**
 * Open the liveDownload recording window with auto-record flag.
 * Called when a stream is detected on a monitored tab.
 * @param {Tab} tab - The tab where the stream was detected
 */
async function openWithAutoRecord(tab) {
  try {
    console.log(ts(), `WaitForStart] Opening auto-record window for tab ${tab.id}`);

    // Extract base URL for duplicate detection
    const baseUrl = tab.url.match(/(https?:\/\/[^\/]+\/[^\/]+\/)/)?.[1];

    if (baseUrl) {
      if (isAlreadyRecording(baseUrl)) {
        console.log(ts(), `WaitForStart] ⚠️ Already recording ${baseUrl}, skipping duplicate`);
        try {
          await chrome.tabs.remove(tab.id);
        } catch (e) {
          console.warn(ts(), `WaitForStart] Could not close monitoring tab:`, e.message);
        }
        return;
      }
    }

    const win = await chrome.windows.getCurrent();
    const prefs = await chrome.storage.local.get({ width: 1000, height: 750 });
    const left = win.left + Math.round((win.width - 1000) / 2);
    const top  = win.top  + Math.round((win.height - 750) / 2);

    const args = new URLSearchParams();
    args.set('tabId',      tab.id);
    args.set('title',      tab.title || '');
    args.set('href',       tab.url || '');
    args.set('autoRecord', 'true');

    const fullUrl = '/recorder/index.html?' + args.toString();
    console.log(ts(), `WaitForStart] Full URL: ${fullUrl}`);

    let newWindow;
    try {
      newWindow = await chrome.windows.create({
        url: fullUrl,
        width: prefs.width,
        height: prefs.height,
        left,
        top,
        type: 'normal',
        focused: true
      });
    } catch (boundsError) {
      // Calculated bounds are outside visible screen space (common when RDS is disconnected).
      // Drop all position and size constraints and let Chrome place the window.
      console.warn(ts(), `WaitForStart] ⚠️ Bounds rejected (${boundsError.message}), retrying without position/size`);
      try {
        newWindow = await chrome.windows.create({
          url: fullUrl,
          type: 'normal',
          focused: true
        });
      } catch (e2) {
        // Still failing — RDS session has no screen at all. Open as popup instead.
        console.warn(ts(), `WaitForStart] ⚠️ Normal window failed too, trying popup`);
        newWindow = await chrome.windows.create({
          url: fullUrl,
          type: 'popup'
        });
      }
    }

    console.log(ts(), `WaitForStart] Window created with id: ${newWindow.id}`);

    chrome.notifications.create({
      type: 'basic',
      iconUrl: '/icons/active/48.png',
      title: 'liveDownload',
      message: `📡 Broadcast detected: ${tab.title || 'Unknown'} - Starting auto-record...`
    });
  } catch (e) {
    console.error(`[WaitForStart] Error in openWithAutoRecord:`, e);
  }
}
