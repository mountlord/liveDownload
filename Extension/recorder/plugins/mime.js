/* liveDownload — https://github.com/your-repo/liveDownload */

chrome.storage.local.get({
  'mime-watch': false
}).then(prefs => {
  document.getElementById('mime-watch').checked = prefs['mime-watch'];

  document.getElementById('mime-watch').onchange = e => {
    chrome.storage.local.set({
      'mime-watch': e.target.checked
    });
  };
});
