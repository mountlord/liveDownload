/**
 * liveDownload - Service Worker Entry Point
 *
 * Load order matters: each module sees globals declared by earlier modules.
 *
 * Network detection (stream URL interception):
 *   block/core.js, block/icon.js, context.js, detector/core.js
 *
 * Our world (live recording):
 *   live/recording-registry.js  → recordingWindows Map, register/unregister helpers
 *   live/window-manager.js      → monitoringWindowIds, openMonitoringWindow, openWithAutoRecord
 *   live/polling-manager.js     → waitingTabs, polling alarm, sequential URL processing
 *   live/wru-manager.js         → WRU persistent storage CRUD
 */

/* global network */

/**
 * ts() — returns a compact timestamp string for log messages: "HH:MM:SS"
 * Available globally to all importScripts modules via self.ts
 */
self.ts = () => {
  const n = new Date();
  const h = String(n.getHours()).padStart(2, '0');
  const m = String(n.getMinutes()).padStart(2, '0');
  const s = String(n.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}]`;
};

if (typeof importScripts !== 'undefined') {
  self.importScripts('block/core.js');
  self.importScripts('block/icon.js');
  self.importScripts('context.js');
  self.importScripts('detector/core.js');
  self.importScripts('live/recording-registry.js');
  self.importScripts('live/window-manager.js');
  self.importScripts('live/polling-manager.js');
  self.importScripts('live/wru-manager.js');
}

self.notify = (tabId, text, title) => {
  chrome.action.setBadgeBackgroundColor({ color: 'red' });
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title });
};

const extra = {};

/* ===========================================
   STARTUP — restore runtime state, then start polling
   Sprint 1: loadRuntimeState() restores recordingWindows and monitoringWindowIds
   from chrome.storage.session, fixing the service worker sleep/restart problem.
   =========================================== */

async function loadRuntimeState() {
  await loadRecordingWindowsFromSession();    // from recording-registry.js
  await loadMonitoringWindowIdsFromSession(); // from window-manager.js
  console.log('[SW] ✅ Runtime state restored from session storage');
}

setTimeout(async () => {
  await loadRuntimeState();
  await initializePolling();
}, 3000);

/* ===========================================
   OPEN RECORDING WINDOW (manual / context-menu)
   =========================================== */

const open = async (tab, extra = []) => {
  try {
    const win   = await chrome.windows.getCurrent();
    const prefs = await chrome.storage.local.get({ width: 1000, height: 750 });

    const left = win.left + Math.round((win.width  - 1000) / 2);
    const top  = win.top  + Math.round((win.height -  750) / 2);

    const args = new URLSearchParams();
    args.set('tabId', tab.id);
    args.set('title', tab.title || '');
    args.set('href',  tab.url   || '');
    for (const { key, value } of extra) args.set(key, value);

    const url = '/recorder/index.html?' + args.toString();

    try {
      await chrome.windows.create({
        url,
        width:  prefs.width,
        height: prefs.height,
        left,
        top,
        type: 'popup'
      });
    } catch (e) {
      // First fallback: strip position, keep size
      console.warn('[SW] ⚠️ Bounds rejected for plugin window, opening without position:', e.message);
      try {
        await chrome.windows.create({ url, width: prefs.width, height: prefs.height, type: 'popup' });
      } catch (e2) {
        // Second fallback: strip everything — let Chrome decide size and position
        console.warn('[SW] ⚠️ Size also rejected, opening with no bounds:', e2.message);
        await chrome.windows.create({ url, type: 'popup' });
      }
    }
  } catch (e) {
    console.error('[SW] ❌ Failed to open plugin window:', e.message);
  }
};

chrome.action.onClicked.addListener(tab => open(tab));
chrome.action.setBadgeBackgroundColor({ color: '#666666' });

/* ===========================================
   BADGE
   =========================================== */

const badge = (n, tabId) => {
  if (n > 0 && waitingTabs.has(tabId)) {
    handleStreamDetected(tabId, n);
  }

  if (n) {
    chrome.action.setIcon({ tabId, path: { '16': '/icons/active/16.png', '32': '/icons/active/32.png', '48': '/icons/active/48.png' } });
    chrome.action.setBadgeText({ tabId, text: new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) });
  } else {
    chrome.action.setIcon({ tabId, path: { '16': '/icons/16.png', '32': '/icons/32.png', '48': '/icons/48.png' } });
    chrome.action.setBadgeText({ tabId, text: '' });
  }
};

/* ===========================================
   OBSERVE
   =========================================== */

const observe = d => {
  if (d.initiator && d.initiator.startsWith('https://www.youtube.com')) return;

  if (
    d.url.includes('.m3u8') === false &&
    d.url.includes('.mpd')  === false &&
    d.type !== 'media' &&
    d.responseHeaders.some(({ name, value }) =>
      (name === 'content-type' || name === 'Content-Type') &&
      value && value.startsWith('text/html')
    )
  ) return;

  chrome.scripting.executeScript({
    target: { tabId: d.tabId },
    func: (size, v) => {
      self.storage = self.storage || new Map();
      self.storage.set(v.url, v);
      if (self.storage.size > size) {
        for (const [href] of self.storage) {
          self.storage.delete(href);
          if (self.storage.size <= size) break;
        }
      }
      return self.storage.size;
    },
    args: [200, { url: d.url, initiator: d.initiator, timeStamp: d.timeStamp, responseHeaders: d.responseHeaders.filter(o => network.HEADERS.includes(o.name.toLowerCase())) }]
  }).then(c => badge(c[0].result, d.tabId)).catch(() => {});
};

observe.mime = d => {
  for (const { name, value } of d.responseHeaders) {
    if ((name === 'content-type' || name === 'Content-Type') && value && (value.startsWith('video/') || value.startsWith('audio/'))) return observe(d);
  }
};

/* ===========================================
   WEB REQUEST LISTENERS
   =========================================== */

chrome.webRequest.onHeadersReceived.addListener(observe, { urls: ['*://*/*'], types: ['media'] }, ['responseHeaders']);

network.types({ core: true }).then(types => {
  const cloned = navigator.userAgent.includes('Firefox') ? d => observe(d) : observe;
  chrome.webRequest.onHeadersReceived.addListener(cloned, { urls: types.map(s => '*://*/*.' + s + '*'), types: ['xmlhttprequest'] }, ['responseHeaders']);
});

network.types({ core: false, sub: true }).then(types => {
  const cloned = navigator.userAgent.includes('Firefox') ? d => observe(d) : observe;
  chrome.webRequest.onHeadersReceived.addListener(cloned, { urls: types.map(s => '*://*/*.' + s + '*'), types: ['xmlhttprequest', 'other'] }, ['responseHeaders']);
});

{
  const run = () => chrome.storage.local.get({ 'mime-watch': false }, prefs => {
    if (prefs['mime-watch']) {
      chrome.webRequest.onHeadersReceived.addListener(observe.mime, { urls: ['*://*/*'], types: ['xmlhttprequest'] }, ['responseHeaders']);
    } else {
      chrome.webRequest.onHeadersReceived.removeListener(observe.mime);
    }
  });
  run();
  chrome.storage.onChanged.addListener(ps => ps['mime-watch'] && run());
}

/* ===========================================
   TAB / WINDOW LIFECYCLE
   =========================================== */

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  handleWRUTabClosed(tabId);
  if (waitingTabs.has(tabId)) {
    console.log(`[WaitForStart] Tab ${tabId} closed, stopping wait`);
    stopWaiting(tabId);
  }
});

/* ===========================================
   MESSAGE ROUTER
   =========================================== */

const raip = () => {
  if (chrome.power) {
    chrome.runtime.sendMessage({ method: 'any-active' }, r => {
      chrome.runtime.lastError;
      if (r !== true) chrome.power.releaseKeepAwake();
    });
  }
};

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'release-awake-if-possible') {
    raip();
  }
  else if (request.method === 'get-extra') {
    response(extra[request.tabId] || []);
    delete extra[request.tabId];
  }
  else if (request.method === 'media-detected') {
    observe({ ...request.d, timeStamp: Date.now(), tabId: sender.tab.id, initiator: sender.url });
  }
  else if (request.method === 'waitForStart-start') {
    startWaiting(request.tabId, request.pageUrl).then(response);
    return true;
  }
  else if (request.method === 'waitForStart-stop') {
    stopWaiting(request.tabId).then(response);
    return true;
  }
  else if (request.method === 'waitForStart-status') {
    const info = getWaitingInfo(request.tabId);
    response({ isWaiting: !!info, info, waitingCount: waitingTabs.size });
  }
  else if (request.method === 'waitForStart-getSettings') {
    getWaitSettings().then(response);
    return true;
  }
  else if (request.method === 'waitForStart-getAll') {
    getAllWaitingTabs().then(response);
    return true;
  }
  else if (request.method === 'settings-updated') {
    if (request.checkInterval !== undefined) {
      updatePollingInterval(request.checkInterval).then(() => response({ success: true }));
      return true;
    }
    response({ success: true });
  }
  else if (request.method === 'recording-getAll') {
    getAllRecordingWindows().then(response);
    return true;
  }
  else if (request.method === 'recording-register') {
    registerRecordingWindow(request.windowId, request.tabId, request.title, request.pageUrl)
      .then(() => response({ success: true }));
    return true;
  }
  else if (request.method === 'recording-unregister') {
    unregisterRecordingWindow(request.windowId)
      .then(() => response({ success: true }));
    return true;
  }
  else if (request.method === 'recording-update') {
    updateRecordingStats(request.windowId, request.duration, request.segments);
    response({ success: true });
  }
  else if (request.method === 'wru-getAll') {
    getAllWRU().then(response);
    return true;
  }
  else if (request.method === 'wru-add') {
    addWRU(request.url, { title: request.title, userInitiated: request.userInitiated, skipPoll: request.skipPoll }).then(response);
    return true;
  }
  else if (request.method === 'wru-delete') {
    deleteWRU(request.url).then(response);
    return true;
  }
  else if (request.method === 'wru-deactivate') {
    deactivateWRU(request.url).then(response);
    return true;
  }
  else if (request.method === 'wru-activate') {
    activateWRU(request.url).then(response);
    return true;
  }
  else if (request.method === 'wru-restoreWaiting') {
    restoreWRUWaiting(request.url).then(response);
    return true;
  }
  else if (request.method === 'wru-addCurrentTab') {
    addWRUCurrentTab(request.url, request.title, request.tabId).then(response);
    return true;
  }
  else if (request.method === 'wru-pollNow') {
    console.log('[WRU] Manual poll triggered by user');
    checkAllActiveURLs()
      .then(() => response({ success: true, tabCount: waitingTabs.size }))
      .catch(e => { console.error('[SW] ❌ Manual poll error:', e.message); response({ success: false }); });
    return true;
  }
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'release-awake-if-possible') raip();
  else if (a.name === 'pollStreams')           checkAllActiveURLs().catch(e => console.error('[SW] ❌ Polling cycle error:', e.message));
});

/* ===========================================
   CLEANUP ON STARTUP / INSTALL
   =========================================== */

{
  const once = async () => { for (const key of await caches.keys()) caches.delete(key); };
  chrome.runtime.onStartup.addListener(once);
}

{
  const once = () => indexedDB.databases().then(dbs => { for (const db of dbs) indexedDB.deleteDatabase(db.Name); });
  if (indexedDB.databases) {
    chrome.runtime.onInstalled.addListener(once);
    chrome.runtime.onStartup.addListener(once);
  }
}

{
  const { management, runtime: { onInstalled, getManifest }, storage, tabs } = chrome;
  if (navigator.webdriver !== true) {
    const { homepage_url: page, name, version } = getManifest();
    onInstalled.addListener(({ reason, previousVersion }) => {
      management.getSelf(({ installType }) => installType === 'normal' && storage.local.get(
        { faqs: true, 'last-update': 0 },
        prefs => {
          if (reason === 'install' || (prefs.faqs && reason === 'update')) {
            const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
            if (doUpdate && previousVersion !== version) {
              tabs.query({ active: true, lastFocusedWindow: true }, tbs => tabs.create({
                url:    page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
                active: reason === 'install',
                ...(tbs && tbs.length && { index: tbs[0].index + 1 })
              }));
              storage.local.set({ 'last-update': Date.now() });
            }
          }
        }
      ));
    });
  }
}
