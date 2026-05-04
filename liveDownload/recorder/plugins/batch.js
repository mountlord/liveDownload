/* liveDownload — https://github.com/your-repo/liveDownload */

/* global error, download */

self.batch = async (jobs, codec) => {
  try {
    const dir = await window.showDirectoryPicker({
      mode: 'readwrite'
    });
    // make sure we are not overwriting existing files
    const filenames = new Set();
    for await (const file of dir.values()) {
      if (file.kind === 'file') {
        filenames.add(file.name);
      }
    }
    const unique = name => {
      if (filenames.has(name)) {
        // try to append "1" to the filename before file extension
        name = name.replace(/\.(?=[^.]+$)/, '-' + 1 + '.');
        return unique(name);
      }
      return name;
    };

    let index = 1;
    for (const {name, segments} of jobs) {
      const n = unique(name);
      filenames.add(n);

      self.aFile = await dir.getFileHandle(n, {
        create: true
      });
      self.aFile.stat = {
        index,
        total: jobs.length
      };
      await download(segments, self.aFile, codec);
      index += 1;
    }

    // Show donate button after all batch jobs complete
    const vodCompletion = document.getElementById('vod-completion');
    const donateBtn = document.getElementById('vod-donate-btn');
    if (vodCompletion) vodCompletion.style.display = '';
    if (donateBtn) {
      donateBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://www.savethechildren.org/savekids' });
      });
    }
  }
  catch (e) {
    error(e);
  }
};
