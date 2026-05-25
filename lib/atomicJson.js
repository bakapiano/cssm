'use strict';

// Atomic JSON-file writes + per-file serialization.
//
// The naive pattern (`fs.writeFile(path, JSON.stringify(...))`) has two
// bugs under concurrent callers:
//
//   1. fs.writeFile overwrites byte-by-byte but does NOT pre-truncate.
//      If writer A's serialization is longer than writer B's, and B
//      finishes second, B writes only its own bytes — A's trailing
//      bytes stay on disk. Result: `]  }\n]` style JSON corruption.
//
//   2. Even with atomic writes, concurrent `load → mutate → save`
//      sequences lose updates: A and B both read state v0, both write
//      their own v1 — the later writer wins, the earlier one's edits
//      vanish.
//
// Fixes:
//
//   - atomicWriteJson: write to a sibling tmp file, then rename onto
//     the target. rename is atomic on the same volume (NTFS / POSIX),
//     so readers see either the old complete file or the new complete
//     file. No truncation problem.
//
//   - withFileLock: serialize all mutators of a given file through a
//     per-path promise chain. Callers wrap their whole load/mutate/save
//     in withFileLock(path, fn) and are guaranteed exclusivity.

const fs = require('node:fs/promises');

async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

const locks = new Map();
function withFileLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow rejections in the chain holder so a single failed mutator
  // doesn't poison every subsequent caller. The returned `next` still
  // rejects for THIS caller — only the stored chain is sanitized.
  locks.set(filePath, next.catch(() => {}));
  return next;
}

module.exports = { atomicWriteJson, withFileLock };
