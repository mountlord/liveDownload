/**
 * liveDownload - WRU Manager
 * Persistent storage for "Wait for Recording URLs" — the list of broadcaster
 * pages the extension monitors for live streams.
 *
 * Architecture:
 *   Persistent layer  → chrome.storage.local 'wruList'
 *                        Each entry: { url, title, inactive, addedAt }
 *   Runtime layer     → waitingTabs Map in polling-manager.js (ephemeral)
 *
 * Prime Directive: user preferences (active/inactive) are NEVER changed by the system.
 *
 * Sprint 1: activateWRU() now triggers the sequential polling system instead of
 * calling openMonitoringWindow() directly, so newly-activated URLs are processed
 * through the same tracked, timeout-managed path as all other URLs.
 *
 * Depends on:
 *   polling-manager.js  (getWaitSettings, startWaiting, checkAllActiveURLs, initializePolling)
 */

'use strict';

// ---------- Storage helpers ----------

async function getWRUList() {
  const stored = await chrome.storage.local.get('wruList');
  let list = stored.wruList || [];

  // Data migration: convert old 'suspended' field to 'inactive',
  // and remove deprecated runtime fields that crept into storage.
  let needsSave = false;
  for (const entry of list) {
    if (entry.suspended !== undefined && entry.inactive === undefined) {
      entry.inactive = entry.suspended;
      delete entry.suspended;
      needsSave = true;
    }
    if (entry.networkSuspended !== undefined) { delete entry.networkSuspended; needsSave = true; }
    if (entry.tabId             !== undefined) { delete entry.tabId;            needsSave = true; }
  }

  if (needsSave) {
    await chrome.storage.local.set({ wruList: list });
    console.log(ts(), 'WRU] Migrated data: removed deprecated runtime state from storage');
  }

  return list;
}

async function saveWRUList(list) {
  await chrome.storage.local.set({ wruList: list });
}

// ---------- CRUD ----------

async function addWRU(url, options = {}) {
  const settings = await getWaitSettings();
  const list     = await getWRUList();

  if (list.some(item => item.url === url)) {
    return { success: false, error: 'URL already in list' };
  }

  const activeCount = list.filter(item => !item.inactive).length;
  if (activeCount >= settings.maxTabs) {
    return { success: false, error: 'max_tabs_reached', maxTabs: settings.maxTabs };
  }

  const newEntry = {
    url,
    title:    options.title || url,
    inactive: false,
    addedAt:  Date.now()
  };

  list.push(newEntry);
  await saveWRUList(list);
  console.log(ts(), `WRU] Added URL to storage: ${url}`);

  // Poll only this newly-added URL immediately, not the entire list.
  if (!options.skipPoll) {
    setTimeout(() => {
      checkSingleURL(newEntry).catch(e => console.error('[WRU] Error in single-URL poll:', e));
    }, 100);
  }

  return { success: true, entry: newEntry };
}

/**
 * Add the currently-open tab to the WRU list.
 * Uses the existing tab instead of opening a new monitoring window.
 */
async function addWRUCurrentTab(url, title, tabId) {
  const settings = await getWaitSettings();
  const list     = await getWRUList();

  if (list.some(item => item.url === url)) {
    return { success: false, error: 'URL already in list' };
  }

  const activeCount = list.filter(item => !item.inactive).length;
  if (activeCount >= settings.maxTabs) {
    return { success: false, error: 'max_tabs_reached', maxTabs: settings.maxTabs }; 
  }

  const newEntry = { url, title: title || url, inactive: false, addedAt: Date.now() };
  list.push(newEntry);
  await saveWRUList(list);

  const waitResult = await startWaiting(tabId, url);
  console.log(ts(), `WRU] Added current tab URL: ${url} (tab ${tabId})`);

  return {
    success: true,
    entry: newEntry,
    waitInfo: waitResult.success ? {
      nextCheck: waitResult.nextCheck,
      checkInterval: waitResult.checkInterval
    } : null
  };
}

async function deleteWRU(url) {
  const list  = await getWRUList();
  const entry = list.find(item => item.url === url);
  if (!entry) return { success: false, error: 'URL not found' };

  await saveWRUList(list.filter(item => item.url !== url));
  console.log(ts(), `WRU] Deleted URL: ${url}`);
  return { success: true };
}

/**
 * Mark a URL as inactive (user action — suppress monitoring).
 * Also immediately signals any in-progress monitoring tab for this URL to abort,
 * so the sequential poller doesn't hold up other URLs for the full timeout.
 */
async function deactivateWRU(url) {
  const list  = await getWRUList();
  const entry = list.find(item => item.url === url);
  if (!entry)         return { success: false, error: 'URL not found' };
  if (entry.inactive) return { success: false, error: 'Already inactive' };

  entry.inactive = true;
  await saveWRUList(list);
  console.log(ts(), `WRU] Deactivated URL (user action): ${url}`);

  // If a monitoring tab is currently open for this URL, signal it to abort immediately.
  // Without this, waitForStreamOrTimeout holds up the sequential poll for the full
  // timeout before moving on — which the user perceives as a spurious Poll Now.
  const normalized = url.replace(/\/$/, '');
  for (const [tabId, info] of waitingTabs) {
    const waiting = info.pageUrl.replace(/\/$/, '');
    if (waiting === normalized || waiting.startsWith(normalized + '/')) {
      console.log(ts(), `WRU] ⏹️ Aborting active monitoring tab ${tabId} for deactivated URL ${url}`);
      externallyAbortedTabs.add(tabId);
      break;
    }
  }

  return { success: true };
}

/**
 * Mark a URL as active (user action) and trigger the sequential polling system.
 *
 * Sprint 1 fix: Previously called openMonitoringWindow() directly, bypassing
 * the sequential poller. Now marks the entry active and triggers checkAllActiveURLs()
 * so the URL is processed through the same tracked, timeout-managed path.
 */
async function activateWRU(url) {
  const settings = await getWaitSettings();
  const list     = await getWRUList();
  const entry    = list.find(item => item.url === url);
  if (!entry)          return { success: false, error: 'URL not found' };
  if (!entry.inactive) return { success: false, error: 'Already active' };

  const activeCount = list.filter(item => !item.inactive).length;
  if (activeCount >= settings.maxTabs) {
    return { success: false, error: 'max_tabs_reached', maxTabs: settings.maxTabs };
  }

  entry.inactive = false;
  await saveWRUList(list);

  console.log(ts(), `WRU] Activated URL (user action): ${url} — triggering immediate single-URL poll`);

  // Poll only this re-activated URL, not the entire list.
  setTimeout(() => {
    checkSingleURL(entry).catch(e => console.error('[WRU] Poll error after activate:', e));
  }, 100);

  return { success: true };
}

/**
 * Confirm a URL is still active after recording stops.
 * The sequential poller will pick it up at the next alarm cycle.
 */
async function restoreWRUWaiting(url) {
  const list  = await getWRUList();
  const entry = list.find(item => item.url === url);

  if (!entry) {
    console.log(ts(), `WRU] URL not in list, cannot restore: ${url}`);
    return { success: false };
  }
  if (entry.inactive) {
    console.log(ts(), `WRU] URL is inactive (user choice), not restoring: ${url}`);
    return { success: false };
  }

  console.log(ts(), `WRU] WRU entry confirmed active, will be monitored at next poll: ${url}`);
  return { success: true };
}

async function getAllWRU() {
  const settings = await getWaitSettings();
  const list     = await getWRUList();
  return { urls: list, maxTabs: settings.maxTabs };
}

// ---------- Lifecycle ----------

/**
 * Called when a monitored tab is closed — stop tracking it.
 * Marks the tab as externally aborted so waitForStreamOrTimeout
 * returns 'aborted' rather than 'stream_detected'.
 */
async function handleWRUTabClosed(tabId) {
  if (waitingTabs.has(tabId)) {
    const info = waitingTabs.get(tabId);
    console.log(ts(), `WRU] Tab ${tabId} closed for URL ${info.pageUrl}`);
    externallyAbortedTabs.add(tabId);  // signal to waitForStreamOrTimeout
    await stopWaiting(tabId);
  }
}
