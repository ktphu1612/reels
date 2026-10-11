import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })) as typeof window.matchMedia,
});
