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

module.exports = {
  listSessions,
  projectSlugForCwd,
  getLiveClaudePids,
  SESSIONS_DIR,
  PROJECTS_DIR,
};
