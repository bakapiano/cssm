'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function projectSlugForCwd(cwd) {
  return String(cwd).replace(/[:\\]/g, '-');
}

function getLiveClaudePids() {
  return new Promise((resolve) => {
    exec(
      'tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH',
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(new Set());
        const pids = new Set();
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/"claude\.exe","(\d+)"/);
          if (m) pids.add(Number(m[1]));
        }
        resolve(pids);
      }
    );
  });
}

async function getAiTitleFromJsonl(jsonlPath) {
  try {
    const stat = await fs.stat(jsonlPath);
    if (stat.size === 0) return null;
    const TAIL = 1024 * 1024;
    const offset = Math.max(0, stat.size - TAIL);
    const readSize = stat.size - offset;
    const fd = await fs.open(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      await fd.read(buf, 0, readSize, offset);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"type":"ai-title"')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.aiTitle) return obj.aiTitle;
        } catch {}
      }
      return null;
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

async function listSessions() {
  let files;
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const livePids = await getLiveClaudePids();

  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (file) => {
        const fullPath = path.join(SESSIONS_DIR, file);
        try {
          const raw = await fs.readFile(fullPath, 'utf8');
          const s = JSON.parse(raw);
          if (!livePids.has(Number(s.pid))) return null;

          const slug = projectSlugForCwd(s.cwd);
          const jsonl = path.join(PROJECTS_DIR, slug, `${s.sessionId}.jsonl`);
          const aiTitle = await getAiTitleFromJsonl(jsonl);

          return {
            pid: s.pid,
            sessionId: s.sessionId,
            cwd: s.cwd,
            status: s.status || 'unknown',
            startedAt: s.startedAt || null,
            updatedAt: s.updatedAt || null,
            version: s.version || null,
            kind: s.kind || null,
            name: s.name || null,
            aiTitle: aiTitle || null,
            title: aiTitle || s.name || null,
            jsonlPath: jsonl,
            sessionFile: fullPath,
          };
        } catch {
          return null;
        }
      })
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Pull cwd/title/firstTimestamp from a jsonl by reading the head (cwd lives in
// any user/assistant/attachment line) and tailing for the last ai-title.
async function readJsonlMetadata(jsonlPath) {
  let fd;
  try {
    fd = await fs.open(jsonlPath, 'r');
    const stat = await fd.stat();
    if (stat.size === 0) return { size: 0 };

    const HEAD = Math.min(stat.size, 128 * 1024);
    const headBuf = Buffer.alloc(HEAD);
    await fd.read(headBuf, 0, HEAD, 0);
    const headText = headBuf.toString('utf8');

    let cwd = null;
    let gitBranch = null;
    let firstTimestamp = null;
    for (const line of headText.split('\n')) {
      if (!line) continue;
      if (cwd && firstTimestamp) break;
      if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
        if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
      } catch {}
    }

    const TAIL = Math.min(stat.size, 512 * 1024);
    const tailBuf = Buffer.alloc(TAIL);
    await fd.read(tailBuf, 0, TAIL, Math.max(0, stat.size - TAIL));
    const tailText = tailBuf.toString('utf8');
    let title = null;
    const tailLines = tailText.split('\n');
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (!tailLines[i].includes('"type":"ai-title"')) continue;
      try {
        const obj = JSON.parse(tailLines[i]);
        if (obj.aiTitle) { title = obj.aiTitle; break; }
      } catch {}
    }

    return { cwd, gitBranch, firstTimestamp, title, size: stat.size };
  } catch {
    return {};
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

// List every recently-used Claude session by enumerating ~/.claude/projects/
// *.jsonl files. Excludes session ids that are currently live (caller passes
// `excludeIds` from listSessions()). Sorted by file mtime desc.
async function listRecentSessions({ limit = 50, excludeIds = null } = {}) {
  let projectDirs;
  try {
    projectDirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const candidates = [];
  for (const slugDir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, slugDir);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      if (excludeIds && excludeIds.has(sessionId)) continue;
      const fullPath = path.join(dirPath, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size === 0) continue;
        candidates.push({
          sessionId,
          slug: slugDir,
          jsonlPath: fullPath,
          mtime: stat.mtimeMs,
        });
      } catch {}
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);

  const results = await Promise.all(
    top.map(async (c) => {
      const meta = await readJsonlMetadata(c.jsonlPath);
      const firstTs = meta.firstTimestamp ? Date.parse(meta.firstTimestamp) : null;
      return {
        sessionId: c.sessionId,
        cwd: meta.cwd || null,
        title: meta.title || null,
        gitBranch: meta.gitBranch || null,
        updatedAt: c.mtime,
        startedAt: Number.isFinite(firstTs) ? firstTs : null,
        jsonlPath: c.jsonlPath,
      };
    })
  );

  // Drop entries with no cwd — can't resume without one
  return results.filter((r) => r.cwd);
}

module.exports = {
  listSessions,
  listRecentSessions,
  projectSlugForCwd,
  getLiveClaudePids,
  SESSIONS_DIR,
  PROJECTS_DIR,
};
