/* liveDownload */

// Context menu setup and click handling.
// Menus are registered once on install/startup and re-registered idempotently.

/* global extra, network */

{
  const registerMenus = () => {
    if (registerMenus.done) return;
    registerMenus.done = true;

    // Remove all existing menus first to avoid duplicate ID errors on reload
    chrome.contextMenus.removeAll(() => {
      // Download link — scoped to supported media file extensions
      network.types({ core: true, extra: true }).then(types => {
        chrome.contextMenus.create({
          id: 'download-link',
          title: 'Download with liveDownload',
          contexts: ['link'],
          targetUrlPatterns: types.map(ext => `*://*/*.${ ext}*`)
        }, () => void chrome.runtime.lastError);
      });

      // Download embedded audio/video element
      chrome.contextMenus.create({
        id: 'download-media',
        title: 'Download with liveDownload',
        contexts: ['audio', 'video']
      }, () => void chrome.runtime.lastError);

      // Extract all links from selected text
      chrome.contextMenus.create({
        id: 'extract-links',
        title: 'Extract Links',
        contexts: ['selection']
      }, () => void chrome.runtime.lastError);

      // Clear detected media list from the extension action badge
      chrome.contextMenus.create({
        id: 'clear',
        title: 'Clear Detected Media List',
        contexts: ['action'],
        documentUrlPatterns: ['*://*/*']
      }, () => void chrome.runtime.lastError);
    });
  };

  chrome.runtime.onInstalled.addListener(registerMenus);
  chrome.runtime.onStartup.addListener(registerMenus);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'clear') {
    // Clear the in-page stream storage Map and reset the badge
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (self.storage) self.storage.clear(); }
    }).catch(() => {});

    chrome.action.setIcon({
      tabId: tab.id,
      path: { 16: '/icons/16.png', 32: '/icons/32.png', 48: '/icons/48.png' }
    });
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  }
  else if (info.menuItemId === 'download-link') {
    open(tab, [{ key: 'append', value: info.linkUrl }]);
  }
  else if (info.menuItemId === 'download-media') {
    open(tab, [{ key: 'append', value: info.srcUrl }]);
  }
  else if (info.menuItemId === 'extract-links') {
    // Request scripting permission if not already granted, then extract
    chrome.permissions.request({ permissions: ['scripting'] }, granted => {
      if (granted === false) return;

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        injectImmediately: true,
        world: 'MAIN',
        func: () => {
          const collected = [];
          const selection = window.getSelection();

          // Collect links from selected ranges
          for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            const fragment = range.cloneContents();
            const wrapper = document.createElement('div');
            wrapper.appendChild(fragment);

            // Anchor element containing the selection
            const ancestor = range.commonAncestorContainer;
            const anchor = ancestor.nodeType === Node.ELEMENT_NODE
              ? ancestor
              : ancestor.parentNode;
            if (anchor.href) collected.push(anchor.href);

            // All anchors inside the selection
            for (const a of wrapper.querySelectorAll('a')) {
              if (a.href) collected.push(a.href);
            }
          }

          // Also extract bare URLs from the selected text
          const urlPattern = /(\b(https?|file):\/\/[-A-Z0-9+&@#\\/%?=~_|!:,.;]*[-A-Z0-9+&@#\\/%=~_|])/gi;
          const textMatches = (selection.toString().match(urlPattern) || [])
            .map(s => s.replace(/&amp;/g, '&'));
          collected.push(...textMatches);

          // Deduplicate and filter empty values
          return [...new Set(collected.filter(Boolean))];
        }
      }).then(results => {
        const links = results.flatMap(r => r.result || []);
        extra[tab.id] = links;
        open(tab, [{ key: 'extra', value: true }]);
      }).catch(e => {
        console.error('[context] extract-links failed:', e);
        self.notify(tab.id, 'E', e.message || 'Unknown error');
      });
    });
  }
});
