window.__ldWasmReady = (async () => {
  const { default: init, SegmentFetcher, SegmentStatus } = await import('./livedownload_core.js');
  await init({ module_or_path: new URL('./livedownload_core_bg.wasm', import.meta.url) });
  window.__ldWasm = { SegmentFetcher, SegmentStatus };
})();
