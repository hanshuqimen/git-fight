import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentationClock } from '../src/effects';

describe('cancellable presentation clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('pauses time and resumes from the same position', async () => {
    const clock = new PresentationClock(); let progress = 0;
    const playing = clock.animate(1000, new AbortController().signal, value => { progress = value; });
    await vi.advanceTimersByTimeAsync(320); const before = progress;
    clock.paused = true; await vi.advanceTimersByTimeAsync(2000);
    expect(progress).toBe(before);
    clock.paused = false; await vi.advanceTimersByTimeAsync(1000); await playing;
    expect(progress).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels without further updates or animation frames', async () => {
    const controller = new AbortController(); const clock = new PresentationClock(); const update = vi.fn();
    const playing = clock.animate(3000, controller.signal, update);
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await playing;
    const count = update.mock.calls.length; await vi.advanceTimersByTimeAsync(4000);
    expect(update).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
  });
  it('skip finishes only the current animation and does not leak into the next', async () => {
    const clock = new PresentationClock(); let progress = 0;
    const first = clock.animate(3000, new AbortController().signal, value => { progress = value; });
    clock.skip(); await vi.advanceTimersByTimeAsync(16); await first; expect(progress).toBe(1);
    const controller = new AbortController(); progress = 0;
    const second = clock.animate(3000, controller.signal, value => { progress = value; });
    await vi.advanceTimersByTimeAsync(16); expect(progress).toBeLessThan(.1);
    controller.abort(); await second;
  });
});
