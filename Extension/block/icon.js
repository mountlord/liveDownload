/* liveDownload */

// Manages the extension icon state.
// Shows a "forbidden" icon on pages where the host is in the block list.
// Refreshes the declarativeContent rules periodically via an alarm.

/* global network */

{
  // Load an image from a URL and return its ImageData for use with SetIcon.
  const loadImageData = async href => {
    const blob = await (await fetch(href)).blob();
    const img = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };

  // Rebuild declarativeContent rules to show the forbidden icon on blocked hosts.
  const updateIcon = async () => {
    if (!chrome.declarativeContent) return;

    const hosts = await network.hosts();
    const blockedHosts = hosts
      .filter(o => o.type === 'host')
      .map(o => o.value.replace(/^\./, ''));

    const imageData = {
      16: await loadImageData('/icons/forbidden/16.png'),
      32: await loadImageData('/icons/forbidden/32.png')
    };

    chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
      if (blockedHosts.length === 0) return;

      const conditions = blockedHosts.map(hostSuffix =>
        new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix } })
      );

      chrome.declarativeContent.onPageChanged.addRules([{
        conditions,
        actions: [new chrome.declarativeContent.SetIcon({ imageData })]
      }]);
    });
  };

  // Refresh icon rules on the update-icon alarm (weekly by default).
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'update-icon') updateIcon();
  });

  // Schedule the alarm once per install/startup — idempotent guard via done flag.
  const scheduleIconUpdate = () => {
    if (scheduleIconUpdate.done) return;
    scheduleIconUpdate.done = true;

    chrome.alarms.create('update-icon', {
      when: Date.now() + 30_000,          // first run 30s after startup
      periodInMinutes: 60 * 24 * 7        // refresh weekly
    });
  };

  chrome.runtime.onInstalled.addListener(scheduleIconUpdate);
  chrome.runtime.onStartup.addListener(scheduleIconUpdate);
}
