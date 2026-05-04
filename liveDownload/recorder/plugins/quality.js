/* liveDownload — https://github.com/your-repo/liveDownload */

chrome.storage.local.get({
  quality: 'highest' // 'selector', 'highest', 'lowest' - default to highest for best quality
}).then(prefs => {
  document.getElementById('quality').value = prefs.quality;

  document.getElementById('quality').onchange = e => {
    chrome.storage.local.set({
      quality: e.target.value
    });
  };
});
