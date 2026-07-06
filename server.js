import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.MAPILLARY_TOKEN;
const PORT = process.env.PORT || 8080;
const MAX_ROUNDS = 5;
const GUESS_TIMEOUT_MS = 60000;
// How long a disconnected player's seat stays reserved (score, host status)
// so a page refresh can rejoin the same room instead of losing everything.
const DISCONNECT_GRACE_MS = 30000;

if (!TOKEN) {
  console.error('MAPILLARY_TOKEN environment variable is not set. Set it in Railway before deploying.');
}

// --- Accounts + score persistence ---
// Note: this SQLite file lives on Railway's local disk, which is ephemeral —
// a redeploy can wipe it unless a persistent volume is attached. Fine for
// now, but worth attaching a Railway volume at this path if you want scores
// to survive redeploys long-term.
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const sessionTokens = new Map(); // token -> userId, in-memory (fine to reset on restart — just requires logging in again)
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_POSSIBLE_SCORE = 5000 * MAX_ROUNDS;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const info = db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, salt, Date.now());
  return { id: info.lastInsertRowid, username };
}
function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function verifyPassword(user, password) {
  const hash = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}
function createSession(userId) {
  const token = crypto.randomUUID();
  sessionTokens.set(token, userId);
  return token;
}
function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const userId = sessionTokens.get(token);
  if (!userId) return null;
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) || null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleSignup(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) {
    return sendJson(res, 400, { error: 'Username must be 3-20 characters (letters, numbers, underscore).' });
  }
  if (password.length < 6) {
    return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
  }
  if (findUserByUsername(username)) {
    return sendJson(res, 409, { error: 'That username is already taken.' });
  }
  const user = createUser(username, password);
  sendJson(res, 200, { token: createSession(user.id), username: user.username });
}
async function handleLogin(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(user, password)) {
    return sendJson(res, 401, { error: 'Incorrect username or password.' });
  }
  sendJson(res, 200, { token: createSession(user.id), username: user.username });
}
function handleLogout(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) sessionTokens.delete(token);
  sendJson(res, 200, { ok: true });
}
function handleMe(req, res) {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not logged in' });
  sendJson(res, 200, { username: user.username });
}
async function handleSubmitScore(req, res) {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not logged in' });
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > MAX_POSSIBLE_SCORE) {
    return sendJson(res, 400, { error: 'Invalid score' });
  }
  db.prepare('INSERT INTO scores (user_id, score, created_at) VALUES (?, ?, ?)').run(user.id, Math.round(score), Date.now());
  sendJson(res, 200, { ok: true });
}
function handleLeaderboard(req, res) {
  const rows = db.prepare(`
    SELECT u.username AS username, MAX(s.score) AS best
    FROM scores s JOIN users u ON u.id = s.user_id
    GROUP BY u.id
    ORDER BY best DESC
    LIMIT 20
  `).all();
  sendJson(res, 200, { leaderboard: rows });
}

// Spread across every inhabited continent so rounds don't keep clustering
// around the North Atlantic. Antarctica is deliberately excluded: there's
// essentially no street-level imagery there (no roads), so it would just
// waste retries.
const SPOTS = [
  // North America
  { name: "New York", lat: 40.7580, lon: -73.9855 },
  { name: "San Francisco", lat: 37.7897, lon: -122.4000 },
  { name: "Toronto", lat: 43.6544, lon: -79.3807 },
  { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
  { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  // South America
  { name: "São Paulo", lat: -23.5505, lon: -46.6333 },
  { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 },
  { name: "Santiago", lat: -33.4489, lon: -70.6693 },
  { name: "Bogotá", lat: 4.7110, lon: -74.0721 },
  { name: "Lima", lat: -12.0464, lon: -77.0428 },
  // Europe
  { name: "London", lat: 51.5100, lon: -0.1340 },
  { name: "Paris", lat: 48.8698, lon: 2.3078 },
  { name: "Amsterdam", lat: 52.3731, lon: 4.8926 },
  { name: "Berlin", lat: 52.5163, lon: 13.3777 },
  { name: "Barcelona", lat: 41.3809, lon: 2.1730 },
  { name: "Madrid", lat: 40.4200, lon: -3.7025 },
  { name: "Rome", lat: 41.8902, lon: 12.4922 },
  // Africa
  { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
  { name: "Nairobi", lat: -1.2921, lon: 36.8219 },
  { name: "Cairo", lat: 30.0444, lon: 31.2357 },
  { name: "Lagos", lat: 6.5244, lon: 3.3792 },
  { name: "Accra", lat: 5.6037, lon: -0.1870 },
  // Asia
  { name: "Tokyo", lat: 35.6595, lon: 139.7005 },
  { name: "Seoul", lat: 37.5665, lon: 126.9780 },
  { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
  { name: "Singapore", lat: 1.3521, lon: 103.8198 },
  { name: "Taipei", lat: 25.0330, lon: 121.5654 },
  { name: "Mumbai", lat: 19.0760, lon: 72.8777 },
  { name: "Hong Kong", lat: 22.3193, lon: 114.1694 },
  { name: "Manila", lat: 14.5995, lon: 120.9842 },
  // Middle East
  { name: "Dubai", lat: 25.2048, lon: 55.2708 },
  { name: "Istanbul", lat: 41.0082, lon: 28.9784 },
  { name: "Tel Aviv", lat: 32.0853, lon: 34.7818 },
  // Oceania
  { name: "Sydney", lat: -33.8568, lon: 151.2153 },
  { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
  { name: "Auckland", lat: -36.8485, lon: 174.7633 },
];

// --- BigInt-safe vector tile parsing (same approach proven out client-side) ---

function readVarintNumber(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos.i++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b >= 0x80);
  return result;
}
function readVarintBigInt(buf, pos) {
  let result = 0n, shift = 0n, b;
  do { b = buf[pos.i++]; result |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b >= 0x80);
  return result;
}
function readTag(buf, pos) {
  const v = readVarintNumber(buf, pos);
  return { field: v >>> 3, wireType: v & 0x7 };
}
function skipField(buf, pos, wireType) {
  if (wireType === 0) { while (buf[pos.i++] >= 0x80) {} }
  else if (wireType === 2) { const len = readVarintNumber(buf, pos); pos.i += len; }
  else if (wireType === 1) pos.i += 8;
  else if (wireType === 5) pos.i += 4;
}
function parseValue(buf, start, end) {
  const pos = { i: start };
  let out = null, isBool = null;
  while (pos.i < end) {
    const { field, wireType } = readTag(buf, pos);
    if ((field === 4 || field === 5 || field === 6) && wireType === 0) {
      out = readVarintBigInt(buf, pos).toString();
    } else if (field === 7 && wireType === 0) {
      isBool = readVarintNumber(buf, pos) !== 0;
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return { str: out, bool: isBool };
}
function parseLayer(buf, start, end) {
  const pos = { i: start };
  let name = null;
  const keys = [], values = [], features = [];
  while (pos.i < end) {
    const { field, wireType } = readTag(buf, pos);
    if (field === 1 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      name = Buffer.from(buf.subarray(pos.i, pos.i + len)).toString('utf8');
      pos.i += len;
    } else if (field === 2 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      features.push({ start: pos.i, end: pos.i + len });
      pos.i += len;
    } else if (field === 3 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      keys.push(Buffer.from(buf.subarray(pos.i, pos.i + len)).toString('utf8'));
      pos.i += len;
    } else if (field === 4 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      values.push(parseValue(buf, pos.i, pos.i + len));
      pos.i += len;
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return { name, keys, values, features };
}
function parseFeatureTags(buf, start, end) {
  const pos = { i: start };
  const tags = [];
  while (pos.i < end) {
    const { field, wireType } = readTag(buf, pos);
    if (field === 2 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      const endT = pos.i + len;
      while (pos.i < endT) tags.push(readVarintNumber(buf, pos));
      pos.i = endT;
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return tags;
}
function parseTileLayers(buf) {
  const pos = { i: 0 };
  const layers = [];
  while (pos.i < buf.length) {
    const { field, wireType } = readTag(buf, pos);
    if (field === 3 && wireType === 2) {
      const len = readVarintNumber(buf, pos);
      layers.push(parseLayer(buf, pos.i, pos.i + len));
      pos.i += len;
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return layers;
}
function extractPreciseImageData(buf) {
  const layers = parseTileLayers(buf);
  const layer = layers.find(l => l.name === 'image');
  if (!layer) return [];
  const idKeyIdx = layer.keys.indexOf('id');
  const panoKeyIdx = layer.keys.indexOf('is_pano');
  if (idKeyIdx === -1) return [];
  const out = [];
  for (const feat of layer.features) {
    const tags = parseFeatureTags(buf, feat.start, feat.end);
    let id = null, isPano = false;
    for (let i = 0; i < tags.length; i += 2) {
      const key = tags[i], valIdx = tags[i + 1];
      if (key === idKeyIdx && layer.values[valIdx]) id = layer.values[valIdx].str;
      if (key === panoKeyIdx && layer.values[valIdx]) isPano = layer.values[valIdx].bool === true;
    }
    if (id) out.push({ id, isPano });
  }
  return out;
}

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y, z };
}

async function findStartImageId(spot) {
  const t = lonLatToTile(spot.lon, spot.lat, 14);
  const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${t.z}/${t.x}/${t.y}?access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());

  const imageData = extractPreciseImageData(buf);
  if (imageData.length === 0) return null;

  const tile = new VectorTile(new Protobuf(buf));
  const layer = tile.layers['image'];
  if (!layer || layer.length === 0) return null;

  const panoIndices = imageData.map((d, i) => d.isPano ? i : -1).filter(i => i !== -1);
  const pool = panoIndices.length > 0 ? panoIndices : imageData.map((_, i) => i);
  const idx = pool[Math.floor(Math.random() * pool.length)];
  const feature = layer.feature(idx);
  const gj = feature.toGeoJSON(t.x, t.y, t.z);
  return { id: imageData[idx].id, lat: gj.geometry.coordinates[1], lon: gj.geometry.coordinates[0] };
}

async function pickLocation(tried = []) {
  const remaining = SPOTS.filter(s => !tried.includes(s.name));
  if (remaining.length === 0) return null;
  // Try a few candidate spots concurrently — a single spot's tile sometimes
  // has no image coverage, and retrying those sequentially was the main
  // source of slow round loads.
  const batch = [...remaining].sort(() => Math.random() - 0.5).slice(0, 3);
  const results = await Promise.all(batch.map(spot => findStartImageId(spot).catch(() => null)));
  const loc = results.find(r => r);
  if (!loc) return pickLocation([...tried, ...batch.map(s => s.name)]);
  return loc;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
// The actual GeoGuessr scoring formula: Score = 5000 * e^(-10*d / 14916862),
// where d is the error distance in meters.
function scoreFromDistance(km) {
  const meters = km * 1000;
  return Math.round(5000 * Math.exp(-10 * meters / 14916862));
}

// --- Room management ---

const rooms = new Map(); // code -> room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const p of room.players.values()) send(p.ws, msg);
}
function playerList(room) {
  return [...room.players.entries()].map(([pid, p]) => ({
    id: pid, name: p.name, score: p.score, guessed: room.guesses.has(pid),
  }));
}
function broadcastPlayers(room) {
  broadcast(room, { type: 'players', players: playerList(room), hostId: room.hostId });
}

async function startRound(room) {
  if (room.round >= MAX_ROUNDS) {
    broadcast(room, { type: 'game_over', players: playerList(room) });
    return;
  }
  room.round++;
  room.guesses = new Map();
  room.currentLocation = null;
  broadcast(room, { type: 'round_loading', round: room.round, maxRounds: MAX_ROUNDS });

  const loc = await pickLocation();
  if (!loc) {
    broadcast(room, { type: 'error', message: 'Could not find a location right now, try starting the round again.' });
    room.round--;
    return;
  }
  room.currentLocation = loc;
  room.roundStartedAt = Date.now();
  broadcastPlayers(room);
  broadcast(room, { type: 'round_start', round: room.round, maxRounds: MAX_ROUNDS, imageId: loc.id, timeLeft: GUESS_TIMEOUT_MS });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishRound(room), GUESS_TIMEOUT_MS);
}

function finishRound(room) {
  if (!room.currentLocation) return;
  clearTimeout(room.timer);
  const results = [];
  for (const [id, player] of room.players) {
    const g = room.guesses.get(id);
    let dist = null, points = 0;
    if (g) {
      dist = haversine(g.lat, g.lon, room.currentLocation.lat, room.currentLocation.lon);
      points = scoreFromDistance(dist);
      player.score += points;
    }
    results.push({ id, name: player.name, dist, points, total: player.score });
  }
  const actual = { lat: room.currentLocation.lat, lon: room.currentLocation.lon };
  room.currentLocation = null;
  broadcast(room, { type: 'round_result', round: room.round, maxRounds: MAX_ROUNDS, actual, results });
}

function maybeFinishRound(room) {
  if (room.currentLocation && room.guesses.size === room.players.size) {
    finishRound(room);
  }
}

// --- WebSocket wiring ---

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('index.html not found next to server.js — make sure it was deployed alongside it.');
        return;
      }
      const html = data.replace('__MAPILLARY_TOKEN__', TOKEN || '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  if (pathname.startsWith('/assets/')) {
    const assetsDir = path.join(__dirname, 'assets');
    const resolved = path.resolve(path.join(assetsDir, pathname.slice('/assets/'.length)));
    if (resolved !== assetsDir && !resolved.startsWith(assetsDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const contentType = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
        '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
      }[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }
  // A thrown/rejected async handler must not crash the whole server over one bad request.
  const guard = (fn) => fn(req, res).catch((err) => {
    console.error('API handler error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  });
  if (pathname === '/api/signup' && req.method === 'POST') return guard(handleSignup);
  if (pathname === '/api/login' && req.method === 'POST') return guard(handleLogin);
  if (pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
  if (pathname === '/api/me' && req.method === 'GET') return handleMe(req, res);
  if (pathname === '/api/score' && req.method === 'POST') return guard(handleSubmitScore);
  if (pathname === '/api/leaderboard' && req.method === 'GET') return handleLeaderboard(req, res);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GuessWhere multiplayer server is running.');
});
const wss = new WebSocketServer({ server });

let nextId = 1;

function roomPhase(room) {
  if (room.currentLocation) return 'round';
  if (room.round === 0) return 'lobby';
  return 'between';
}

function removePlayer(room, id) {
  room.players.delete(id);
  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastPlayers(room);
  maybeFinishRound(room);
}

wss.on('connection', (ws) => {
  let id = nextId++;
  let room = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      const code = generateCode();
      const token = crypto.randomUUID();
      room = {
        code, players: new Map(), round: 0, guesses: new Map(),
        currentLocation: null, hostId: id, timer: null, roundStartedAt: null,
      };
      room.players.set(id, { ws, name: (msg.name || 'Player').slice(0, 20), score: 0, token, disconnectTimer: null });
      rooms.set(code, room);
      send(ws, { type: 'room_created', code, id, hostId: id, token });
      broadcastPlayers(room);
    }

    else if (msg.type === 'join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: 'Room not found. Check the code.' }); return; }
      const token = crypto.randomUUID();
      room.players.set(id, { ws, name: (msg.name || 'Player').slice(0, 20), score: 0, token, disconnectTimer: null });
      send(ws, { type: 'room_joined', code: room.code, id, hostId: room.hostId, round: room.round, maxRounds: MAX_ROUNDS, token });
      broadcastPlayers(room);
    }

    else if (msg.type === 'rejoin') {
      const code = (msg.code || '').toUpperCase().trim();
      const targetRoom = rooms.get(code);
      if (!targetRoom) { send(ws, { type: 'rejoin_failed' }); return; }
      let foundId = null, player = null;
      for (const [pid, p] of targetRoom.players) {
        if (p.token === msg.token) { foundId = pid; player = p; break; }
      }
      if (!player) { send(ws, { type: 'rejoin_failed' }); return; }

      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
      player.ws = ws;
      id = foundId;
      room = targetRoom;

      const phase = roomPhase(room);
      send(ws, {
        type: 'rejoined',
        id, hostId: room.hostId, code: room.code, round: room.round, maxRounds: MAX_ROUNDS,
        players: playerList(room), phase,
        imageId: phase === 'round' ? room.currentLocation.id : undefined,
        timeLeft: phase === 'round' ? Math.max(0, GUESS_TIMEOUT_MS - (Date.now() - room.roundStartedAt)) : undefined,
        alreadyGuessed: room.guesses.has(foundId),
      });
      broadcastPlayers(room);
    }

    else if (msg.type === 'start_round') {
      if (!room || room.hostId !== id) return;
      await startRound(room);
    }

    else if (msg.type === 'submit_guess') {
      if (!room || !room.currentLocation || room.guesses.has(id)) return;
      if (typeof msg.lat !== 'number' || typeof msg.lon !== 'number') return;
      room.guesses.set(id, { lat: msg.lat, lon: msg.lon });
      broadcastPlayers(room);
      maybeFinishRound(room);
    }

    else if (msg.type === 'leave_room') {
      if (!room) return;
      const player = room.players.get(id);
      if (player) clearTimeout(player.disconnectTimer);
      removePlayer(room, id);
      room = null;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;
    player.ws = null;
    // Don't tear down the seat immediately — a refresh reconnects within
    // this window via 'rejoin' and picks the same score/host status back up.
    player.disconnectTimer = setTimeout(() => removePlayer(room, id), DISCONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => console.log('GuessWhere multiplayer server listening on', PORT));