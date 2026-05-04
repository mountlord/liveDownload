/* liveDownload */

// Shared recorder utilities: timestamp generation, translation, UI helpers,
// and file save dialog option builder.

/**
 * Generate a human-readable timestamp with seconds: Mar-27-2026-10-33-05AM
 * Single source of truth for all filename timestamps across the recorder.
 */
self.getHumanTimestamp = () => {
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month  = months[now.getMonth()];
  const day    = String(now.getDate()).padStart(2, '0');
  const year   = now.getFullYear();
  const hours  = now.getHours();
  const mins   = String(now.getMinutes()).padStart(2, '0');
  const secs   = String(now.getSeconds()).padStart(2, '0');
  const ampm   = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${month}-${day}-${year}-${hour12}-${mins}-${secs}${ampm}`;
};

/**
 * Translate text to English via Google Translate public endpoint.
 * Returns the original text on any failure.
 */
self.translateText = async text => {
  if (!text?.trim()) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = data?.[0]?.[0]?.[0];
    if (!translated) throw new Error('Unexpected response format');
    return translated;
  } catch (e) {
    console.warn('[liveDownload] Translation error:', e.message);
    return text;
  }
};

// Temporarily replace the document title with a notification message,
// restoring the original after a timeout.
{
  let restoreTimer;
  let originalTitle;

  self.notify = (msg, timeout = 750) => {
    if (restoreTimer === undefined) {
      originalTitle = document.title;
    }
    document.title = msg;

    if (timeout) {
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        document.title = originalTitle;
        restoreTimer = undefined;
      }, timeout);
    }
  };
}

// Modal prompt/confirm dialog backed by the #prompt element in index.html.
{
  const queue = [];

  self.prompt = (msg, buttons = { ok: 'Retry', no: 'Cancel', value: '' }, confirm = false) => {
    return new Promise((resolve, reject) => {
      const dialog = document.getElementById('prompt');
      queue.push({ resolve, reject });

      if (dialog.open) return; // already showing — will resolve via onclose

      dialog.querySelector('p').textContent = msg;
      dialog.dataset.mode = confirm ? 'confirm' : 'prompt';

      const input    = dialog.querySelector('[name=value]');
      const okBtn    = dialog.querySelector('[value=default]');
      const cancelBtn = dialog.querySelector('[value=cancel]');
      const extraBtns = [...dialog.querySelectorAll('[value=extra]')];

      input.required = confirm;
      input.value    = buttons.value;
      input.type     = isNaN(buttons.value) ? 'text' : 'number';
      input.select();

      okBtn.textContent    = buttons.ok;
      cancelBtn.textContent = buttons.no;
      extraBtns.forEach((btn, i) => {
        btn.textContent = buttons.extra?.[i] ?? '';
      });

      let result = new Error('USER_ABORT');

      dialog.onsubmit = e => {
        e.preventDefault();
        if (e.submitter.value === 'default') {
          result = input.value;
          dialog.close();
        } else if (e.submitter.value === 'extra') {
          result = e.submitter.dataset.id;
          dialog.close();
        }
      };

      dialog.onclick = e => {
        if (e.target.value === 'cancel') dialog.close();
      };

      dialog.onclose = () => {
        if (result instanceof Error) {
          queue.forEach(({ reject }) => reject(result));
        } else {
          queue.forEach(({ resolve }) => resolve(result));
        }
        queue.length = 0;
      };

      dialog.showModal();
      (confirm ? input : okBtn).focus();
    });
  };
}

const helper = {};

// Returns true if the entry can be downloaded directly (not a stream manifest).
helper.downloadable = ({ meta, entry }) => {
  const STREAM_TYPES = ['m3u8', 'mpd'];
  const STREAM_PATTERNS = [
    '.m3u8', '.mpd', 'format=m3u8', 'format=mpd',
    'data:application/dash+xml',
    'data:application/vnd.apple.mpegurl',
    'data:x-mpegURL',
    'data:audio/mpegurl',
    'data:audio/x-mpegurl'
  ];

  if (meta.ext === 'txt') return false;
  if (STREAM_TYPES.includes(meta.ext)) return false;
  return !STREAM_PATTERNS.some(p => entry.url.includes(p));
};

// Build options for showSaveFilePicker based on the detected media type.
helper.options = ({ meta }) => {
  const options = {
    types: [{ description: 'Video or Audio Files' }]
  };

  if (meta.ext === 'm3u8' || meta.ext === 'mpd') {
    // Stream — save as TS or MKV container
    const format = document.getElementById('default-format').value;
    options.types[0].accept = format === 'ts'
      ? { 'video/MP2T': ['.ts'] }
      : { 'video/mkv':  ['.mkv'] };

    options.suggestedName =
      (meta.gname || meta.name || 'Untitled') +
      (meta.index ? ` - ${meta.index}` : '') +
      `-${self.getHumanTimestamp()}.${format}`;
  }
  else if (meta.ext === '') {
    options.types[0].accept = { 'video/mkv': ['.mkv'] };
    options.suggestedName =
      (meta.gname || meta.name || 'Untitled') +
      (meta.index ? ` - ${meta.index}` : '') +
      '.mkv';
  }
  else if (meta.ext) {
    // Only pass MIME to the picker if it's a valid media type —
    // passing text/html or similar causes a TypeError.
    const isMediaMime = meta.mime && (
      meta.mime.startsWith('video/') ||
      meta.mime.startsWith('audio/') ||
      meta.mime === 'application/octet-stream'
    );
    if (isMediaMime) {
      options.types[0].accept = { [meta.mime]: ['.' + meta.ext] };
    }
    options.suggestedName =
      (meta.gname || meta.name || 'Untitled') +
      (meta.index ? ` - ${meta.index}` : '') +
      '.' + meta.ext;
  }

  return options;
};
