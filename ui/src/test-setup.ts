/**
 * Shared vitest setup (registered via vitest.config.mts `setupFiles`).
 *
 * 1. Loads the Angular JIT compiler before anything touches @angular/core.
 *    The fesm2022 bundles of Angular libraries are partially compiled and
 *    need the JIT compiler as a fallback; without this import every spec
 *    dies with "JIT compilation failed for injectable ...".
 * 2. Replaces node 25's stub `localStorage`/`sessionStorage` globals.
 *    Node v25 ships a global `localStorage` whose methods are `undefined`
 *    unless node is started with `--localstorage-file`, and vitest's jsdom
 *    environment does not replace the pre-existing global. ConfigService's
 *    field initializers call `localStorage.getItem(...)` at construction
 *    time, so app/generate/setup specs throw "localStorage.getItem is not
 *    a function" without this shim. The property MUST stay writable and
 *    configurable: config.spec.ts reassigns `globalThis.localStorage` to
 *    its own mock.
 * 3. Initializes the Angular testing environment exactly once per test
 *    file (vitest isolates module registries per file, so this re-runs
 *    cleanly). Without it every TestBed spec fails with "Need to call
 *    TestBed.initTestEnvironment() first".
 */
import '@angular/compiler';

import {getTestBed} from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

function createStorageShim(): Storage {
  const store = new Map<string, string>();
  const shim = {
    getItem: (key: string): string | null =>
      store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    get length(): number {
      return store.size;
    },
  };
  return shim as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: createStorageShim(),
    writable: true,
    configurable: true,
  });
}

getTestBed().initTestEnvironment(
  BrowserTestingModule,
  platformBrowserTesting(),
);
