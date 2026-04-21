import {vi} from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // Required by Angular CDK
    removeListener: vi.fn(), // Required by Angular CDK
    addEventListener: vi.fn(), // Required by ConfigService
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
