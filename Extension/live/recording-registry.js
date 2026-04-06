/**
 * liveDownload - Recording Registry
 * Tracks active recording windows: Map<windowId, {tabId, title, pageUrl, startTime, duration, segments}>
 *
 * Sprint 1: recordingWindows is persisted to chrome.storage.session so the
 * service worker can recover its state after a sleep/restart.
 * storage.session survives SW sleep but is cleared when the browser closes.
 */

'use strict';

// In-memory Map — kept in sync with chrome.storage.session after every mutation.
// Map<windowId (number), {tabId, title, pageUrl, startTime, duration, segments}>
const recordingWindows = new Map();

// ---------- Session storage helpers ----------

async function _saveRecordingWindows() {
  const arr = [];
  for (const [windowId, info] of recordingWindows) {
    arr.push({ windowId, ...info });
  }
  try {
    await chrome.storage.session.set({ recordingWindows: arr });
  } catch (e) {
    console.warn(ts(), 'Recording] Could not save to session storage:', e.message);
  }
}

/**
 * Called once at service worker startup to restore state from session storage.
 * Stale window entries (windows that were closed while SW was asleep) are
 * cleaned up lazily by getAllRecordingWindows().
 */
async function loadRecordingWindowsFromSession() {
  try {
    const data = await chrome.storage.session.get('recordingWindows');
    const arr = data.recordingWindows || [];
    for (const { windowId, ...info } of arr) {
      recordingWindows.set(windowId, info);
    }
    if (arr.length > 0) {
      console.log(ts(), `Recording] ✅ Restored ${arr.length} recording window(s) from session`);
    }
  } catch (e) {
    console.warn(ts(), 'Recording] Could not restore from session storage:', e.message);
  }
}

// ---------- CRUD ----------

async function registerRecordingWindow(windowId, tabId, title, pageUrl) {
  recordingWindows.set(windowId, {
    tabId,
    title,
    pageUrl,
    startTime: Date.now(),
    duration: '0:00',
    segments: 0
  });
  console.log(ts(), `Recording] Registered window ${windowId} for tab ${tabId} (${pageUrl})`);
  await _saveRecordingWindows();
}

async function unregisterRecordingWindow(windowId) {
  recordingWindows.delete(windowId);
  console.log(ts(), `Recording] Unregistered window ${windowId}`);
  await _saveRecordingWindows();
}

// updateRecordingStats is called very frequently (every segment download).
// We do NOT persist on every stats update to avoid hammering session storage.
// The windowId + pageUrl metadata (which matters for isAlreadyRecording) is
// persisted when the window is registered.
function updateRecordingStats(windowId, duration, segments) {
  const info = recordingWindows.get(windowId);
  if (info) {
    info.duration = duration;
    info.segments = segments;
  }
}

async function getAllRecordingWindows() {
  const tabs = [];
  let changed = false;

  for (const [windowId, info] of recordingWindows) {
    try {
      await chrome.windows.get(windowId);
      tabs.push({
        windowId,
        tabId: info.tabId,
        title: info.title,
        duration: info.duration,
        segments: info.segments
      });
    } catch (e) {
      // Window no longer exists — clean up
      recordingWindows.delete(windowId);
      changed = true;
    }
  }

  if (changed) await _saveRecordingWindows();
  return { count: tabs.length, tabs };
}

// Check if a base URL is already being recorded.
// Normalizes trailing slashes on both sides to avoid false negatives like
// Path-segment match: checks that baseUrl is a path prefix of pageUrl, not just a substring.
// e.g. base="example.com/user" matches page="example.com/user/12345" ✅
//      base="example.com/use"  does NOT match page="example.com/user/12345" ✅ (was false-positive with includes())
function isAlreadyRecording(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  console.log(ts(), `Recording] Checking if ${normalizedBase} is already recording...`);
  for (const [windowId, info] of recordingWindows) {
    const normalizedPage = (info.pageUrl || '').replace(/\/$/, '');
    console.log(ts(), `Recording]   - Window ${windowId}: pageUrl="${normalizedPage}"`);
    // Match only if pageUrl equals baseUrl exactly OR starts with baseUrl followed by '/'
    // This prevents "example.com/user" from matching "example.com/username"
    if (normalizedPage && (
      normalizedPage === normalizedBase ||
      normalizedPage.startsWith(normalizedBase + '/')
    )) {
      console.log(ts(), `Recording] ✅ Match found! Already recording ${normalizedBase} in window ${windowId}`);
      return true;
    }
  }
  console.log(ts(), `Recording] ❌ No match found for ${normalizedBase}`);
  return false;
}

// ---------- Lifecycle ----------

// Clean up when a recording window is closed by the user
chrome.windows.onRemoved.addListener(async (windowId) => {
  if (recordingWindows.has(windowId)) {
    console.log(ts(), `Recording] Window ${windowId} closed, removing from tracking`);
    recordingWindows.delete(windowId);
    await _saveRecordingWindows();
  }
});
