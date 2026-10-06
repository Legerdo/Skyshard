import { describe, it, expect } from 'vitest';

// Keeps `npm test` green before any game modules exist; imports nothing from src.
describe('smoke', () => {
  it('runs the Vitest toolchain', () => {
    expect(1 + 1).toBe(2);
  });
});
