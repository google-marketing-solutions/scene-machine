/**
 * Storage-only test setup for the official Angular unit-test builder
 * (`@angular/build:unit-test`), registered via `angular.json`
 * `test.options.setupFiles`.
 *
 * The builder owns Angular test initialization — it emits and runs its own
 * TestBed bootstrap before these setup files run — so this file must NOT import
 * `@angular/compiler` or call `getTestBed().initTestEnvironment(...)`; doing
 * either double-initializes the testing environment. Those were jobs of the old
 * bespoke Vitest harness, not of a builder-owned run.
 *
 * Its only job is a runtime storage guard. Some Node versions (25/26) ship a
 * global `localStorage`/`sessionStorage` whose methods are `undefined` unless
 * Node is started with `--localstorage-file`, and jsdom does not replace the
 * pre-existing global. `ConfigService` reads `localStorage.getItem(...)` in a
 * field initializer at construction time, so without a usable shim those specs
 * throw "localStorage.getItem is not a function". CI runs Node 22 (where storage
 * is usable, so this is a no-op); the shim only installs on runtimes that lack
 * usable storage. It stays writable/configurable so a spec can still swap in its
 * own mock.
 */

function createStorageShim(): Storage {
  const store = new Map<string, string>();
  const shim = {
    get length(): number {
      return store.size;
    },
    clear: (): void => {
      store.clear();
    },
    getItem: (key: string): string | null => store.get(key) ?? null,
    key: (index: number): string | null =>
      Array.from(store.keys())[index] ?? null,
    removeItem: (key: string): void => {
      store.delete(key);
    },
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
  };
  return shim as Storage;
}

function hasUsableStorage(storage: Storage | undefined): storage is Storage {
  try {
    return (
      !!storage &&
      typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function'
    );
  } catch {
    return false;
  }
}

for (const storageName of ['localStorage', 'sessionStorage'] as const) {
  const current = globalThis[storageName] as Storage | undefined;
  if (!hasUsableStorage(current)) {
    Object.defineProperty(globalThis, storageName, {
      configurable: true,
      writable: true,
      value: createStorageShim(),
    });
  }
}

/**
 * jsdom does not provide a usable `matchMedia`, yet `ConfigService` (and Angular
 * CDK layout utilities) call `document.defaultView.matchMedia(...)` at
 * construction — so any spec that builds a real component tree needs it. Provide
 * a plain (non-vi.fn) stub here: setupFiles re-run for every test file, so it is
 * present deterministically regardless of import order or which worker a file
 * lands in. A per-spec mock proved flaky under the builder's parallel file
 * runner — a sibling file could leave `matchMedia` undefined for the next file —
 * and a plain function is immune to vitest's mock reset/restore between tests.
 */
function createMatchMediaStub(): (query: string) => MediaQueryList {
  return (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: createMatchMediaStub(),
  });
}
