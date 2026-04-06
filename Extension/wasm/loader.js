import init, { SegmentFetcher, SegmentStatus } from './livedownload_core.js';
await init({ module_or_path: new URL('./livedownload_core_bg.wasm', import.meta.url) });
window.__ldWasm = { SegmentFetcher, SegmentStatus };
