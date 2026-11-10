// Throughput counter: how many things happened in the last minute. Used for the "coins per minute"
// figures the dashboard shows for bot 1 and bot 2.

export function createMeter(windowMs = 60_000) {
  let stamps = [];
  return {
    hit(count = 1, now = Date.now()) {
      for (let i = 0; i < count; i += 1) stamps.push(now);
      if (stamps.length > 100_000) stamps = stamps.slice(-100_000);
    },
    perMinute(now = Date.now()) {
      stamps = stamps.filter((at) => now - at < windowMs);
      return Math.round(stamps.length * (60_000 / windowMs));
    },
  };
}
