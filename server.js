import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.MAPILLARY_TOKEN;
const PORT = process.env.PORT || 8080;
const MAX_ROUNDS = 5;
const GUESS_TIMEOUT_MS = 60000;

if (!TOKEN) {
  console.error('MAPILLARY_TOKEN environment variable is not set. Set it in Railway before deploying.');
}

const SPOTS = [
  { name: "New York", lat: 40.7580, lon: -73.9855 },
  { name: "London", lat: 51.5100, lon: -0.1340 },
  { name: "Paris", lat: 48.8698, lon: 2.3078 },
  { name: "Tokyo", lat: 35.6595, lon: 139.7005 },
  { name: "Amsterdam", lat: 52.3731, lon: 4.8926 },
  { name: "Berlin", lat: 52.5163, lon: 13.3777 },
  { name: "Barcelona", lat: 41.3809, lon: 2.1730 },
  { name: "San Francisco", lat: 37.7897, lon: -122.4000 },
  { name: "Sydney", lat: -33.8568, lon: 151.2153 },
  { name: "Toronto", lat: 43.6544, lon: -79.3807 },
  { name: "Madrid", lat: 40.4200, lon: -3.7025 },
  { name: "Rome", lat: 41.8902, lon: 12.4922 },
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
  const spot = remaining[Math.floor(Math.random() * remaining.length)];
  const loc = await findStartImageId(spot);
  if (!loc) return pickLocation([...tried, spot.name]);
  return loc;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function scoreFromDistance(km) {
  return Math.round(5000 * Math.exp(-km / 2000));
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
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
  broadcastPlayers(room);
  broadcast(room, { type: 'round_start', round: room.round, maxRounds: MAX_ROUNDS, imageId: loc.id });

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
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'geoguesser.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('geoguesser.html not found next to server.js — make sure it was deployed alongside it.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GuessWhere multiplayer server is running.');
});
const wss = new WebSocketServer({ server });

let nextId = 1;

wss.on('connection', (ws) => {
  const id = nextId++;
  let room = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      const code = generateCode();
      room = {
        code, players: new Map(), round: 0, guesses: new Map(),
        currentLocation: null, hostId: id, timer: null,
      };
      room.players.set(id, { ws, name: (msg.name || 'Player').slice(0, 20), score: 0 });
      rooms.set(code, room);
      send(ws, { type: 'room_created', code, id, hostId: id });
      broadcastPlayers(room);
    }

    else if (msg.type === 'join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: 'Room not found. Check the code.' }); return; }
      room.players.set(id, { ws, name: (msg.name || 'Player').slice(0, 20), score: 0 });
      send(ws, { type: 'room_joined', code: room.code, id, hostId: room.hostId, round: room.round, maxRounds: MAX_ROUNDS });
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
  });

  ws.on('close', () => {
    if (!room) return;
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
  });
});

server.listen(PORT, () => console.log('GuessWhere multiplayer server listening on', PORT));