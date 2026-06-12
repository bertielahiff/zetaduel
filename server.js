/* ============================================================
 *  ZetaDuel server — live rooms + persistent leaderboard
 *  Zero dependencies. Node 18+. Run:  node server.js
 *  Then open  http://localhost:3000  (or your machine's IP)
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

const MAX_NAME = 24;
const MAX_SCORE = 2000;
const MAX_BOARD = 500;
const MAX_ROOMS = 100;
const MAX_PLAYERS_PER_ROOM = 24;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;   // rooms vanish after 2h idle
const DURATIONS = [30, 60, 120, 300];

/* ---------------- persistent leaderboard ---------------- */
let board = { entries: [] };
try {
  board = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(board.entries)) board = { entries: [] };
  console.log(`[boot] loaded ${board.entries.length} scores from ${DATA_FILE}`);
} catch (e) {
  console.log('[boot] starting a fresh score file');
}
let saveTimer = null;
function saveBoardSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(board), (err) => {
      if (err) console.error('[save] failed:', err.message);
    });
  }, 400);
}
function addEntry(e) {
  board.entries.push(e);
  board.entries.sort((a, b) => b.s - a.s || a.ts - b.ts);
  if (board.entries.length > MAX_BOARD) board.entries = board.entries.slice(0, MAX_BOARD);
  saveBoardSoon();
}

/* ---------------- sanitisers ---------------- */
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().toUpperCase().slice(0, MAX_NAME);
}
function cleanScore(s) {
  s = parseInt(s, 10);
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, s));
}
function cleanCfg(c) {
  c = c || {};
  const num = (v, d, lo, hi) => {
    v = parseInt(v, 10);
    if (!Number.isFinite(v)) v = d;
    return Math.max(lo, Math.min(hi, v));
  };
  const cfg = {
    dur: DURATIONS.includes(parseInt(c.dur, 10)) ? parseInt(c.dur, 10) : 120,
    ops: {
      add: !!(c.ops && c.ops.add), sub: !!(c.ops && c.ops.sub),
      mul: !!(c.ops && c.ops.mul), div: !!(c.ops && c.ops.div)
    },
    aA0: num(c.aA0, 2, 0, 9999), aA1: num(c.aA1, 100, 0, 9999),
    aB0: num(c.aB0, 2, 0, 9999), aB1: num(c.aB1, 100, 0, 9999),
    mA0: num(c.mA0, 2, 0, 999), mA1: num(c.mA1, 12, 0, 999),
    mB0: num(c.mB0, 2, 0, 9999), mB1: num(c.mB1, 100, 0, 9999)
  };
  if (!cfg.ops.add && !cfg.ops.sub && !cfg.ops.mul && !cfg.ops.div) cfg.ops = { add: true, sub: true, mul: true, div: true };
  if (cfg.aA0 > cfg.aA1) [cfg.aA0, cfg.aA1] = [cfg.aA1, cfg.aA0];
  if (cfg.aB0 > cfg.aB1) [cfg.aB0, cfg.aB1] = [cfg.aB1, cfg.aB0];
  if (cfg.mA0 > cfg.mA1) [cfg.mA0, cfg.mA1] = [cfg.mA1, cfg.mA0];
  if (cfg.mB0 > cfg.mB1) [cfg.mB0, cfg.mB1] = [cfg.mB1, cfg.mB0];
  return cfg;
}
function opsSummary(cfg) {
  const s = [];
  if (cfg.ops.add) s.push('+'); if (cfg.ops.sub) s.push('\u2212');
  if (cfg.ops.mul) s.push('\u00D7'); if (cfg.ops.div) s.push('\u00F7');
  return s.join(' ');
}

/* ---------------- rooms ---------------- */
const rooms = new Map();   // code -> room
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O — unambiguous

function newRoomCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function makeRoom(hostId, hostName, cfg) {
  const code = newRoomCode();
  if (!code) return null;
  const room = {
    code, hostId, cfg,
    state: 'lobby',            // lobby | live | done
    round: 0, seed: 0, startAt: 0,
    players: new Map(),        // pid -> {id,name,score,done,online,participant}
    clients: new Set(),        // SSE responses
    endTimer: null,
    touched: Date.now()
  };
  room.players.set(hostId, { id: hostId, name: hostName, score: 0, done: false, online: false, participant: false });
  rooms.set(code, room);
  return room;
}
function roomSnapshot(room) {
  return {
    type: 'room',
    code: room.code, state: room.state, hostId: room.hostId,
    cfg: room.cfg, round: room.round, seed: room.seed, startAt: room.startAt,
    serverNow: Date.now(),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, done: p.done, online: p.online, participant: p.participant
    }))
  };
}
function broadcast(room, obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of room.clients) {
    try { res.write(payload); } catch (e) { /* dropped */ }
  }
}
function broadcastRoom(room) { broadcast(room, roomSnapshot(room)); }
function touch(room) { room.touched = Date.now(); }

function ensureHost(room) {
  if (room.players.has(room.hostId) && room.players.get(room.hostId).online) return;
  const next = [...room.players.values()].find(p => p.online);
  if (next) room.hostId = next.id;
}
function maybeEndRound(room) {
  if (room.state !== 'live') return;
  const parts = [...room.players.values()].filter(p => p.participant);
  if (parts.length && parts.every(p => p.done || !p.online)) endRound(room);
}
function endRound(room) {
  if (room.state !== 'live') return;
  clearTimeout(room.endTimer);
  room.state = 'done';
  touch(room);
  broadcastRoom(room);
}
function startRound(room) {
  room.round += 1;
  room.seed = crypto.randomInt(0xFFFFFFFF);
  room.startAt = Date.now() + 4000;
  room.state = 'live';
  for (const p of room.players.values()) {
    p.score = 0; p.done = false;
    p.participant = p.online;
  }
  clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => endRound(room), 4000 + room.cfg.dur * 1000 + 15000);
  touch(room);
  broadcastRoom(room);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS && room.clients.size === 0) {
      clearTimeout(room.endTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

/* ---------------- http plumbing ---------------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  /* ---- static ---- */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500); return res.end('index.html missing — keep it next to server.js');
    }
  }
  if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  /* ---- api ---- */
  try {
    if (p === '/api/ping') return send(res, 200, { ok: true, server: 'zetaduel', now: Date.now() });

    if (p === '/api/leaderboard' && req.method === 'GET') {
      return send(res, 200, { ok: true, entries: board.entries.slice(0, 300) });
    }

    if (p === '/api/result' && req.method === 'POST') {
      const b = await readBody(req);
      const dur = parseInt(b.d, 10);
      if (!DURATIONS.includes(dur)) return send(res, 400, { ok: false, error: 'bad duration' });
      const name = cleanName(b.n);
      if (!name) return send(res, 400, { ok: false, error: 'name required' });
      const code = b.c ? String(b.c).slice(0, 40) : null;
      // attempt number is authoritative: counted by NAME + challenge code on the server,
      // so replays can't hide even across devices
      let at = Math.max(1, parseInt(b.at, 10) || 1);
      if (code) {
        const prior = board.entries.filter(e => e.n === name && e.c === code).length;
        at = Math.max(at, prior + 1);
      }
      addEntry({
        n: name, s: cleanScore(b.s), d: dur, c: code,
        ops: String(b.ops || '').slice(0, 12),
        ts: Date.now(), at, r: at > 1 ? 1 : 0
      });
      return send(res, 200, { ok: true, at });
    }

    if (p === '/api/room' && req.method === 'POST') {
      const b = await readBody(req);
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { ok: false, error: 'server full of rooms' });
      const pid = String(b.pid || '').slice(0, 40);
      if (!pid) return send(res, 400, { ok: false, error: 'no pid' });
      const hostName = cleanName(b.name);
      if (!hostName) return send(res, 400, { ok: false, error: 'name required' });
      const room = makeRoom(pid, hostName, cleanCfg(b.cfg));
      if (!room) return send(res, 503, { ok: false, error: 'no codes left' });
      return send(res, 200, { ok: true, room: roomSnapshot(room) });
    }

    const m = p.match(/^\/api\/room\/([A-Z]{4})\/(events|join|leave|start|score|finish|settings)$/);
    if (m) {
      const room = rooms.get(m[1]);
      if (!room) return send(res, 404, { ok: false, error: 'no such room' });
      const action = m[2];

      if (action === 'events' && req.method === 'GET') {
        const pid = String(url.searchParams.get('pid') || '').slice(0, 40);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(': connected\n\n');
        room.clients.add(res);
        const pl = room.players.get(pid);
        if (pl) { pl.online = true; touch(room); }
        res.write(`data: ${JSON.stringify(roomSnapshot(room))}\n\n`);
        broadcastRoom(room);
        const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
        req.on('close', () => {
          clearInterval(hb);
          room.clients.delete(res);
          const q = room.players.get(pid);
          if (q) {
            q.online = false;
            if (room.state === 'lobby') room.players.delete(pid);
            ensureHost(room);
            maybeEndRound(room);
            touch(room);
            broadcastRoom(room);
          }
        });
        return;
      }

      const b = await readBody(req);
      const pid = String(b.pid || '').slice(0, 40);
      if (!pid) return send(res, 400, { ok: false, error: 'no pid' });

      if (action === 'join') {
        const joinName = cleanName(b.name);
        if (!joinName) return send(res, 400, { ok: false, error: 'name required' });
        if (!room.players.has(pid) && room.players.size >= MAX_PLAYERS_PER_ROOM)
          return send(res, 403, { ok: false, error: 'room full' });
        const existing = room.players.get(pid);
        if (existing) existing.name = joinName;
        else room.players.set(pid, { id: pid, name: joinName, score: 0, done: false, online: false, participant: false });
        touch(room); broadcastRoom(room);
        return send(res, 200, { ok: true, room: roomSnapshot(room) });
      }
      if (action === 'leave') {
        room.players.delete(pid);
        ensureHost(room); maybeEndRound(room); touch(room); broadcastRoom(room);
        return send(res, 200, { ok: true });
      }
      if (action === 'settings') {
        if (pid !== room.hostId) return send(res, 403, { ok: false, error: 'host only' });
        if (room.state === 'live') return send(res, 409, { ok: false, error: 'round in progress' });
        room.cfg = cleanCfg(b.cfg);
        touch(room); broadcastRoom(room);
        return send(res, 200, { ok: true });
      }
      if (action === 'start') {
        if (pid !== room.hostId) return send(res, 403, { ok: false, error: 'host only' });
        if (room.state === 'live') return send(res, 409, { ok: false, error: 'already running' });
        startRound(room);
        return send(res, 200, { ok: true });
      }
      if (action === 'score') {
        const pl = room.players.get(pid);
        if (!pl || room.state !== 'live') return send(res, 409, { ok: false, error: 'not live' });
        pl.score = cleanScore(b.score);
        touch(room);
        broadcast(room, { type: 'score', pid, name: pl.name, score: pl.score, round: room.round });
        return send(res, 200, { ok: true });
      }
      if (action === 'finish') {
        const pl = room.players.get(pid);
        if (!pl) return send(res, 404, { ok: false, error: 'not in room' });
        if (!pl.done) {
          pl.done = true;
          pl.score = cleanScore(b.score);
          addEntry({
            n: pl.name, s: pl.score, d: room.cfg.dur,
            c: 'RM.' + room.code + '.' + room.round,
            ops: opsSummary(room.cfg), ts: Date.now(), at: 1, r: 0
          });
        }
        touch(room); broadcastRoom(room); maybeEndRound(room);
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return send(res, 400, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ZetaDuel server is up.');
  console.log(`  Local:    http://localhost:${PORT}`);
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name]) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log(`  Network:  http://${ni.address}:${PORT}   <- share this with friends on your wifi`);
        }
      }
    }
  } catch (e) {}
  console.log(`  Scores persist in ${DATA_FILE}`);
  console.log('');
});
