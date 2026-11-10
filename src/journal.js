import fs from "node:fs";
import path from "node:path";

// Append-only JSONL log of every decision (rejections with reasons, scores, entries, exits) so the
// strategy can be tuned from evidence instead of guesses. Writes are buffered and flushed in
// batches; the file rotates to `<file>.1` once it passes maxBytes. Entries must never contain
// secrets (API keys, RPC URLs).

const MAX_BUFFERED = 5000;

export function createJournal({
  filePath = path.resolve("data", "journal.jsonl"),
  maxBytes = 5 * 1024 * 1024,
  flushMs = 2000,
  onError = (error) => console.error(`[journal] ${error.message}`),
} = {}) {
  let buffer = [];
  let timer = null;

  function flush() {
    if (!buffer.length) return;
    const chunk = buffer.join("");
    buffer = [];
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        if (fs.statSync(filePath).size > maxBytes) fs.renameSync(filePath, `${filePath}.1`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      fs.appendFileSync(filePath, chunk, "utf8");
    } catch (error) {
      onError(error);
    }
  }

  return {
    filePath,
    write(entry) {
      buffer.push(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
      if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
    },
    start() {
      if (timer) return;
      timer = setInterval(flush, flushMs);
      timer.unref?.();
    },
    flush,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      flush();
    },
  };
}
