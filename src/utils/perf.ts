type PerfDetail = Record<string, unknown>;

interface PerfMeasureRecord {
  name: string;
  duration: number;
  startTime: number;
  detail?: PerfDetail;
}

interface PerfStore {
  measures: PerfMeasureRecord[];
  active: Record<string, number>;
}

const MAX_STORED_MEASURES = 500;

declare global {
  interface Window {
    __JUNBAN_PERF__?: PerfStore;
  }
}

function getNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getStore(): PerfStore | null {
  if (typeof window === "undefined") {
    return null;
  }

  window.__JUNBAN_PERF__ ??= {
    measures: [],
    active: {},
  };

  return window.__JUNBAN_PERF__;
}

function recordMeasure(
  name: string,
  startTime: number,
  duration: number,
  detail?: PerfDetail,
): void {
  const store = getStore();
  if (!store) {
    return;
  }

  store.measures.push({
    name,
    duration,
    startTime,
    detail,
  });

  if (store.measures.length > MAX_STORED_MEASURES) {
    store.measures.splice(0, store.measures.length - MAX_STORED_MEASURES);
  }
}

export function markPerf(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }

  try {
    performance.mark(name);
  } catch {
    // ignore duplicate or unsupported mark issues in older environments
  }
}

export function beginNamedPerfSpan(name: string): void {
  const store = getStore();
  if (!store) {
    return;
  }

  store.active[name] = getNow();
  markPerf(`${name}:start`);
}

export function endNamedPerfSpan(name: string, detail?: PerfDetail): void {
  const store = getStore();
  if (!store) {
    return;
  }

  const startTime = store.active[name];
  if (typeof startTime !== "number") {
    return;
  }

  const duration = getNow() - startTime;
  delete store.active[name];
  markPerf(`${name}:end`);
  recordMeasure(name, startTime, duration, detail);
}

export function measureSync<T>(name: string, fn: () => T, detail?: PerfDetail): T {
  const startTime = getNow();
  markPerf(`${name}:start`);
  try {
    return fn();
  } finally {
    const duration = getNow() - startTime;
    markPerf(`${name}:end`);
    recordMeasure(name, startTime, duration, detail);
  }
}

export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: PerfDetail,
): Promise<T> {
  const startTime = getNow();
  markPerf(`${name}:start`);
  try {
    return await fn();
  } finally {
    const duration = getNow() - startTime;
    markPerf(`${name}:end`);
    recordMeasure(name, startTime, duration, detail);
  }
}

export function clearPerfMeasures(): void {
  const store = getStore();
  if (!store) {
    return;
  }

  store.measures = [];
  store.active = {};
}
