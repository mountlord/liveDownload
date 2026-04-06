/* liveDownload */

// Core network detection and blocking module.
// Defines supported media types and the block list logic used across the extension.

const network = {
  // Response headers captured for each detected request
  HEADERS: ['content-length', 'content-range', 'accept-ranges', 'content-type', 'content-disposition'],
  // Path to the bundled block list
  LIST: '/block/blocked.json',
  // Cache storage name for the block list
  CACHE: 'liveDownload.block'
};

// Media type definitions
{
  const CORE = [
    'flv', 'avi', 'wmv', 'mov', 'mp4', 'webm', 'mkv',           // video
    'pcm', 'wav', 'mp3', 'aac', 'ogg', 'wma', 'm4a', 'weba', 'opus', // audio
    'm3u8', 'mpd'                                                  // streams
  ];
  const EXTRA = ['zip', 'rar', '7z', 'tar.gz', 'img', 'iso', 'bin', 'exe', 'dmg', 'deb'];
  const SUB   = ['vtt', 'webvtt', 'srt'];

  // Returns the active type list from storage, falling back to the default selection.
  network.types = (query = { core: true }) => {
    const defaults = [
      ...(query.core  ? CORE  : []),
      ...(query.extra ? EXTRA : []),
      ...(query.sub   ? SUB   : [])
    ];
    return new Promise(resolve =>
      chrome.storage.local.get({ 'network.types': defaults }, prefs =>
        resolve(prefs['network.types'])
      )
    );
  };
}

// Block list loading and matching
{
  // Load the block list — served from cache when available, fetched fresh otherwise.
  network.hosts = async () => {
    const cache = await caches.open(network.CACHE);
    const cached = await cache.match(network.LIST);
    const response = cached || await fetch(network.LIST);
    return response.json();
  };

  // Returns a matcher function that checks whether a given request should be blocked.
  // Block list entry types:
  //   { type: 'host',   value: '.youtube.com' }              — block same-origin streams
  //   { type: 'stream', value: '.gstatic.com', hosts: ['*'] } — block stream URLs everywhere
  network.blocked = async () => {
    const entries = await network.hosts();
    const hostRules   = entries.filter(o => o.type === 'host');
    const streamRules = entries.filter(o => o.type === 'stream');

    return ({ host, stream }) => {
      // Block streams that originate from a blocked host
      if (host) {
        for (const rule of hostRules) {
          const isSameOrigin = host.includes(rule.value) &&
            host.split(rule.value)[0].split('/').length === 3;
          if (isSameOrigin && stream.includes(rule.value)) {
            return { value: true, reason: `Downloading from "${rule.value}" is blocked` };
          }
        }
      }

      // Block specific stream URLs, optionally scoped to certain hosts
      if (stream) {
        for (const rule of streamRules) {
          if (!stream.includes(rule.value)) continue;
          const allowedHosts = rule.hosts || [];
          if (allowedHosts.includes('*')) {
            return { value: true, reason: `"${rule.value}" streams are blocked on all hosts` };
          }
          for (const h of allowedHosts) {
            const isMatchingHost = host.includes(h) &&
              host.split(h)[0].split('/').length === 3;
            if (isMatchingHost) {
              return { value: true, reason: `"${rule.value}" streams are blocked on "${h}"` };
            }
          }
        }
      }

      return { value: false };
    };
  };
}
