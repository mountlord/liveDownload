/* liveDownload — https://github.com/your-repo/liveDownload */

chrome.storage.local.get({
  'default-format': 'ts'
}).then(prefs => {
  document.getElementById('default-format').value = prefs['default-format'];
});

document.getElementById('default-format').onchange = e => chrome.storage.local.set({
  'default-format': e.target.value
});
