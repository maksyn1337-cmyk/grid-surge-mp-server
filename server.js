/* ══════════════════════════════════════════════════════════════
   GRID SURGE — Multiplayer (Versus Mode) relay server
   --------------------------------------------------------------
   A tiny, lightweight Socket.io relay that pairs two players into
   a room, hands them a synchronized shape queue, and forwards
   real-time gameplay events (grid mirrors, sabotage combos,
   win/loss, disconnects) between them with minimal latency.

   No game logic runs here beyond room bookkeeping & shape-queue
   generation — all gameplay simulation stays client-side, so the
   server stays cheap to host and trivially horizontally-scalable
   (sticky sessions / single instance is enough for 1v1 rooms).

   DEPLOY:
     1. npm install
     2. node server.js            (or `npm start`)
     3. Point index.html's MP_SERVER_URL at this server's public URL
        e.g. wss://your-app.onrender.com or https://your-app.fly.dev
   ══════════════════════════════════════════════════════════════ */
'use strict';

var express = require('express');
var http = require('http');
var { Server } = require('socket.io');

var PORT = process.env.PORT || 3001;
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // matches client MP_CODE_CHARS (no ambiguous glyphs)
var QUEUE_LEN = 60;            // shapes pre-generated per match (queue wraps if exhausted)
var SHAPES_COUNT = 9;          // must match client SHAPES.length in index.html
var MOD_CHANCE = 0.16;         // probability a spawned shape carries a modifier
var MODS = ['bomb', 'ice', 'multiplier'];

var app = express();
var server = http.createServer(app);
var io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 8000,
  pingTimeout: 12000,
});

app.get('/', function (req, res) {
  res.type('text/plain').send('Grid Surge multiplayer relay — OK. Rooms: ' + Object.keys(rooms).length);
});
app.get('/healthz', function (req, res) { res.status(200).send('ok'); });

/* ── Room bookkeeping ──
   rooms[code] = { code, host: socket|null, guest: socket|null, queue: [...] } */
var rooms = Object.create(null);
var socketRoom = Object.create(null); // socket.id -> room code

function randCode() {
  var s = '';
  for (var i = 0; i < 4; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}
function freshCode() {
  var c, tries = 0;
  do { c = randCode(); tries++; } while (rooms[c] && tries < 50);
  return c;
}
function buildShapeQueue() {
  var q = [];
  for (var i = 0; i < QUEUE_LEN; i++) {
    var entry = { s: (Math.random() * SHAPES_COUNT) | 0, m: null };
    if (Math.random() < MOD_CHANCE) entry.m = MODS[(Math.random() * MODS.length) | 0];
    q.push(entry);
  }
  return q;
}
function otherPlayer(room, socket) {
  if (!room) return null;
  if (room.host && room.host.id !== socket.id) return room.host;
  if (room.guest && room.guest.id !== socket.id) return room.guest;
  return null;
}
function destroyRoom(code) {
  var room = rooms[code];
  if (!room) return;
  if (room.host) delete socketRoom[room.host.id];
  if (room.guest) delete socketRoom[room.guest.id];
  delete rooms[code];
}

/* ── Air Hockey room bookkeeping (separate namespace from Versus rooms) ──
   ahRooms[code] = { code, host, guest, hostInfo:{nickname,stats}, guestInfo }  */
var ahRooms = Object.create(null);
var ahSocketRoom = Object.create(null);
function ahFreshCode() {
  var c, tries = 0;
  do { c = randCode(); tries++; } while (ahRooms[c] && tries < 50);
  return c;
}
function ahOtherPlayer(room, socket) {
  if (!room) return null;
  if (room.host && room.host.id !== socket.id) return room.host;
  if (room.guest && room.guest.id !== socket.id) return room.guest;
  return null;
}
function ahDestroyRoom(code) {
  var room = ahRooms[code];
  if (!room) return;
  if (room.host) delete ahSocketRoom[room.host.id];
  if (room.guest) delete ahSocketRoom[room.guest.id];
  delete ahRooms[code];
}
function ahSanitizeInfo(info) {
  var nickname = (info && typeof info.nickname === 'string' && info.nickname.trim())
    ? info.nickname.trim().substring(0, 20)
    : ('Guest_' + (100 + ((Math.random() * 900) | 0)));
  var stats = (info && info.stats && typeof info.stats === 'object') ? info.stats : {};
  var wins = (typeof stats.wins === 'number' && stats.wins >= 0) ? Math.floor(stats.wins) : 0;
  var losses = (typeof stats.losses === 'number' && stats.losses >= 0) ? Math.floor(stats.losses) : 0;
  return { nickname: nickname, stats: { wins: wins, losses: losses } };
}

io.on('connection', function (socket) {
  socket.on('create_room', function () {
    // A socket may only host/join a single room at a time.
    if (socketRoom[socket.id]) return;
    var code = freshCode();
    rooms[code] = { code: code, host: socket, guest: null, queue: null };
    socketRoom[socket.id] = code;
    socket.join(code);
    socket.emit('room_created', { code: code });
  });

  socket.on('join_room', function (rawCode) {
    if (socketRoom[socket.id]) return;
    var code = String(rawCode || '').toUpperCase().trim();
    var room = rooms[code];
    if (!room) { socket.emit('join_error', 'Room not found. Check the code and try again.'); return; }
    if (room.guest) { socket.emit('join_error', 'That room is already full.'); return; }
    if (room.host && room.host.id === socket.id) { socket.emit('join_error', 'You cannot join your own room.'); return; }

    room.guest = socket;
    socketRoom[socket.id] = code;
    socket.join(code);

    // Build ONE shared shape queue — both clients pull from the same array
    // so their Strike Zones are guaranteed identical.
    room.queue = buildShapeQueue();
    var payload = { queue: room.queue, startAt: Date.now() + 600 };

    if (room.host) room.host.emit('match_found', payload);
    room.guest.emit('match_found', payload);
  });

  // Relay this player's grid snapshot to their opponent (for the 30% mini-preview)
  socket.on('grid_update', function (grid) {
    var code = socketRoom[socket.id];
    var room = rooms[code];
    if (!room) return;
    var opp = otherPlayer(room, socket);
    if (opp) opp.emit('opponent_grid', grid);
  });

  // Combo (2+ simultaneous lines) → opponent receives one trash block
  socket.on('combo', function (lineCount) {
    var code = socketRoom[socket.id];
    var room = rooms[code];
    if (!room) return;
    if (!(lineCount >= 2)) return;
    var opp = otherPlayer(room, socket);
    if (opp) opp.emit('incoming_trash');
  });

  // This player lost (timer ran out / board locked) → opponent wins
  socket.on('player_lost', function (finalScore) {
    var code = socketRoom[socket.id];
    var room = rooms[code];
    if (!room) return;
    var opp = otherPlayer(room, socket);
    if (opp) opp.emit('opponent_lost', { score: finalScore || 0 });
    // Keep the room alive briefly in case of late reconnect/UI settle, then clean up.
    setTimeout(function () { destroyRoom(code); }, 4000);
  });

  socket.on('disconnect', function () {
    var code = socketRoom[socket.id];
    if (!code) return;
    var room = rooms[code];
    if (!room) { delete socketRoom[socket.id]; return; }
    var opp = otherPlayer(room, socket);
    if (opp) opp.emit('opponent_disconnected');
    delete socketRoom[socket.id];
    destroyRoom(code);
  });

  /* ── ARCADE — Neon Air Hockey room relay ──
     Separate room bookkeeping from Versus Mode (a socket only ever
     occupies one Air Hockey room at a time). The server does zero
     physics — it just pairs players, exchanges nickname/stat info,
     and relays lightweight normalized position/velocity packets so
     the host's authoritative simulation stays in sync with the guest. */
  socket.on('ah_create_room', function (info) {
    if (ahSocketRoom[socket.id]) return;
    var code = ahFreshCode();
    ahRooms[code] = {
      code: code, host: socket, guest: null,
      hostInfo: ahSanitizeInfo(info), guestInfo: null,
    };
    ahSocketRoom[socket.id] = code;
    socket.join('ah_' + code);
    socket.emit('ah_room_created', { code: code });
  });

  socket.on('ah_join_room', function (msg) {
    if (ahSocketRoom[socket.id]) return;
    var code = String((msg && msg.code) || '').toUpperCase().trim();
    var room = ahRooms[code];
    if (!room) { socket.emit('ah_join_error', 'Room not found. Check the code and try again.'); return; }
    if (room.guest) { socket.emit('ah_join_error', 'That room is already full.'); return; }
    if (room.host && room.host.id === socket.id) { socket.emit('ah_join_error', 'You cannot join your own room.'); return; }

    room.guest = socket;
    room.guestInfo = ahSanitizeInfo(msg);
    ahSocketRoom[socket.id] = code;
    socket.join('ah_' + code);

    if (room.host) {
      room.host.emit('ah_match_found', { oppName: room.guestInfo.nickname, oppStats: room.guestInfo.stats });
    }
    room.guest.emit('ah_match_found', { oppName: room.hostInfo.nickname, oppStats: room.hostInfo.stats });
  });

  // Host → guest: who serves first ("Losowanie" coin flip result)
  socket.on('ah_coin', function (d) {
    var room = ahRooms[ahSocketRoom[socket.id]];
    if (!room || !room.host || room.host.id !== socket.id) return;
    var opp = ahOtherPlayer(room, socket);
    if (opp) opp.emit('ah_coin', d);
  });

  // Guest → host: own mallet position (table-normalized, ~20Hz)
  socket.on('ah_mallet', function (d) {
    var room = ahRooms[ahSocketRoom[socket.id]];
    if (!room) return;
    var opp = ahOtherPlayer(room, socket);
    if (opp) opp.emit('ah_mallet', d);
  });

  // Host → guest: authoritative puck/mallet/score snapshot (table-normalized, ~20Hz)
  socket.on('ah_state', function (d) {
    var room = ahRooms[ahSocketRoom[socket.id]];
    if (!room || !room.host || room.host.id !== socket.id) return;
    if (room.guest) room.guest.emit('ah_state', d);
  });

  // Host → guest: goal scored (triggers FX + score sync on guest)
  socket.on('ah_goal', function (d) {
    var room = ahRooms[ahSocketRoom[socket.id]];
    if (!room || !room.host || room.host.id !== socket.id) return;
    if (room.guest) room.guest.emit('ah_goal', d);
  });

  // Host → guest: match finished (first to 5)
  socket.on('ah_match_over', function (d) {
    var room = ahRooms[ahSocketRoom[socket.id]];
    if (!room || !room.host || room.host.id !== socket.id) return;
    if (room.guest) room.guest.emit('ah_match_over', d);
    var code = ahSocketRoom[socket.id];
    setTimeout(function () { ahDestroyRoom(code); }, 4000);
  });

  socket.on('disconnect', function () {
    var code = ahSocketRoom[socket.id];
    if (!code) return;
    var room = ahRooms[code];
    if (!room) { delete ahSocketRoom[socket.id]; return; }
    var opp = ahOtherPlayer(room, socket);
    if (opp) opp.emit('ah_opponent_disconnected');
    delete ahSocketRoom[socket.id];
    ahDestroyRoom(code);
  });
});

server.listen(PORT, function () {
  console.log('Grid Surge multiplayer relay listening on :' + PORT);
});
