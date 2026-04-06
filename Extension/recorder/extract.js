/* liveDownload */

// Media extraction utilities.
// Three strategies for finding media URLs in a tab:
//   1. storage   — reads from the in-page Map populated by network request interception
//   2. performance — reads from the browser's Resource Timing API
//   3. player    — reads from known player objects (JW Player, Video.js, SoundManager)

/* global network */

const extract = {};

// Read all entries from the in-page storage Map injected by the content script.
extract.storage = async tabId => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => {
        self.storage = self.storage || new Map();
        return [...self.storage.values()];
      }
    });
    return results[0].result ?? [];
  } catch {
    return [];
  }
};

// Extract media entries from the Performance Resource Timing API.
extract.performance = async tabId => {
  try {
    const types = await network.types({ core: true, extra: false, sub: true });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      world: 'MAIN',
      args: [types],
      func: types => performance.getEntriesByType('resource')
        .filter(entry => {
          if (entry.contentType?.startsWith('video/') ||
              entry.contentType?.startsWith('audio/')) return true;
          if (['video', 'audio', 'other', 'xmlhttprequest'].includes(entry.initiatorType)) {
            return types.some(t => entry.name.includes('.' + t));
          }
          return false;
        })
        .map(entry => ({
          initiator: location.href,
          url: entry.name,
          timeStamp: performance.timeOrigin + entry.startTime,
          source: 'performance'
        }))
    });
    return results[0].result ?? [];
  } catch {
    return [];
  }
};

// Extract media from known JavaScript player objects embedded in the page.
// Supports JW Player, Video.js, and SoundManager.
extract.player = async tabId => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'MAIN',
      func: () => {
        const list = [];
        const ts = () => performance.timing.domComplete;
        const entry = (url, source, type) => {
          const item = { initiator: location.href, url: new URL(url, location.href).href, timeStamp: ts(), source };
          if (type) item.responseHeaders = [{ name: 'Content-Type', value: type }];
          return item;
        };

        // JW Player
        try {
          for (const item of self.jwplayer().getPlaylist()) {
            if (item.file) list.push(entry(item.file, 'jwPlayer/1'));
            for (const src of item.sources || []) {
              if (src.file) list.push(entry(src.file, 'jwPlayer/2'));
            }
          }
        } catch {}

        // Video.js — via getAllPlayers() and DOM query
        const addVideoJS = player => {
          try {
            const src = player.tech().currentSource_;
            if (src?.src) list.push(entry(src.src, 'VideoJS', src.type));
          } catch {}
        };
        try { for (const p of self.videojs.getAllPlayers()) addVideoJS(p); } catch {}
        for (const el of document.querySelectorAll('video-js, .video-js')) {
          if (el.player) addVideoJS(el.player);
        }

        // SoundManager
        try {
          for (const { url } of Object.values(self.soundManager.sounds)) {
            list.push(entry(url, 'SoundManager'));
          }
        } catch {}

        return list;
      }
    });
    return results.flatMap(r => r.result || []).filter(Boolean);
  } catch {
    return [];
  }
};
