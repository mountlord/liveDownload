/* liveDownload */

// Polyfill for browsers without native File System Access API (e.g. Brave, Firefox).
// Falls back to Origin Private File System (OPFS) for all file operations.
// Both showSaveFilePicker and showDirectoryPicker are marked _polyfilled = true
// so callers can detect OPFS mode and trigger a download on completion.

if (typeof self.showSaveFilePicker === 'undefined') {

  // Trigger a browser download from an OPFS file handle, then remove the OPFS entry.
  FileSystemFileHandle.prototype.download = async function () {
    const blob = await this.getFile();
    const objectURL = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = objectURL;
    // Strip the random prefix added by getFileHandle proxy below (format: "xxxxx - name")
    anchor.download = this.name.replace(/^[a-z0-9]+ - /, '');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(objectURL);
      navigator.storage.getDirectory().then(root => root.removeEntry(this.name)).catch(() => {});
    }, 200);
  };

  // Proxy getFileHandle to prepend a random prefix, ensuring OPFS filenames are unique
  // even when two recordings share the same base name.
  FileSystemDirectoryHandle.prototype.getFileHandle = new Proxy(
    FileSystemDirectoryHandle.prototype.getFileHandle,
    {
      apply(target, ctx, args) {
        const prefix = Math.random().toString(36).substring(2, 7);
        args[0] = `${prefix} - ${args[0]}`;
        return Reflect.apply(target, ctx, args);
      }
    }
  );

  // Polyfill showSaveFilePicker — creates a file in OPFS root.
  self.showSaveFilePicker = function (options = {}) {
    return navigator.storage.getDirectory().then(root =>
      root.getFileHandle(options.suggestedName || 'download', { create: true })
    );
  };
  self.showSaveFilePicker._polyfilled = true;

  // Polyfill showDirectoryPicker — returns OPFS root directory.
  self.showDirectoryPicker = function () {
    return navigator.storage.getDirectory();
  };
  self.showDirectoryPicker._polyfilled = true;
}
