/* liveDownload */

// Manages registration of blob/MIME detection content scripts.
// When "Detect Streams in XHR Requests" is enabled, injects two scripts:
//   - main.js (MAIN world): proxies the Blob constructor to catch M3U8 blobs
//   - isolated.js (ISOLATED world): relays detected media to the service worker

const SCRIPT_IDS = ['ld_detector_main', 'ld_detector_isolated'];

const SCRIPT_PROPS = {
  matches: ['*://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start'
};

const activateDetector = async () => {
  if (activateDetector.busy) return;
  activateDetector.busy = true;

  try {
    // Always unregister first to avoid stale registrations
    await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => {});

    const prefs = await chrome.storage.local.get({ 'mime-watch': false });

    if (prefs['mime-watch']) {
      await chrome.scripting.registerContentScripts([
        { ...SCRIPT_PROPS, id: SCRIPT_IDS[0], world: 'MAIN',     js: ['/detector/inject/main.js'] },
        { ...SCRIPT_PROPS, id: SCRIPT_IDS[1], world: 'ISOLATED', js: ['/detector/inject/isolated.js'] }
      ]);
    }
  } catch (e) {
    console.warn('[detector] Failed to register content scripts:', e.message);
  } finally {
    activateDetector.busy = false;
  }
};

chrome.runtime.onStartup.addListener(activateDetector);
chrome.runtime.onInstalled.addListener(activateDetector);
chrome.storage.onChanged.addListener(changes => {
  if (changes['mime-watch']) activateDetector();
});
