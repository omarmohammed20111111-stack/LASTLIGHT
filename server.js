
/*
 * LASTLIGHT
 * Authoritative HTTP + WebSocket multiplayer match server
 * Compatible with Render, Railway and local Node.js hosting.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ============================================================
// 1. CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT) || 8080;
const MAX_CLIENTS = 160;
const MAX_ROOM_MEMBERS = 12;
const TICK_RATE = 30;
const STATE_BROADCAST_INTERVAL = 2;

const rooms = new Map();
const clients = new Map();

const HTML_PATH = path.join(__dirname, 'LASTLIGHT.html');

// ============================================================
// 2. LOAD THE GAME ENGINE FROM LASTLIGHT.html
// ============================================================

if (!fs.existsSync(HTML_PATH)) {
    throw new Error(
        'LASTLIGHT.html was not found. Keep it beside server.js.'
    );
}

const html = fs.readFileSync(HTML_PATH, 'utf8');

const engineMatch = html.match(
    /<script\s+id=["']simulation["'][^>]*>([\s\S]*?)<\/script>/i
);

if (!engineMatch) {
    throw new Error(
        'Could not find <script id="simulation"> in LASTLIGHT.html.'
    );
}

const engine = { exports: {} };

try {
    new Function(
        'module',
        'exports',
        engineMatch[1]
    )(engine, engine.exports);
} catch (error) {
    console.error('Game engine loading failed:', error);
    process.exit(1);
}

const { Game, height } = engine.exports;

if (typeof Game !== 'function') {
    throw new Error(
        'The simulation script must export a Game class.'
    );
}

if (typeof height !== 'function') {
    throw new Error(
        'The simulation script must export the height function.'
    );
}

console.log('LASTLIGHT game engine loaded successfully.');

// ============================================================
// 3. HTTP SERVER
// ============================================================

const server = http.createServer((req, res) => {
    const pathname = new URL(
        req.url,
        'http://localhost'
    ).pathname;

    // Health check for Render
    if (pathname === '/health') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });

        return res.end(JSON.stringify({
            ok: true,
            game: 'LASTLIGHT',
            players: clients.size,
            rooms: rooms.size,
            uptime: Math.floor(process.uptime())
        }));
    }

    // Serve the standalone game
    if (
        req.method === 'GET' &&
        (pathname === '/' || pathname === '/LASTLIGHT.html')
    ) {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
        });

        return res.end(html);
    }

    if (req.method === 'HEAD' && pathname === '/') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8'
        });

        return res.end();
    }

    res.writeHead(404, {
        'Content-Type': 'text/plain'
    });

    res.end('Not found');
});

// ============================================================
// 4. WEBSOCKET SERVER
// ============================================================

const wss = new WebSocketServer({
    server,
    maxPayload: 4096,
    perMessageDeflate: false
});

// ============================================================
// 5. COMMUNICATION FUNCTIONS
// ============================================================

function send(client, message) {
    if (
        client &&
        client.ws.readyState === WebSocket.OPEN &&
        client.ws.bufferedAmount < 400000
    ) {
        client.ws.send(JSON.stringify(message));
    }
}

function fan(room, message) {
    for (const id of room.members) {
        const client = clients.get(id);

        if (client) {
            send(client, message);
        }
    }
}

function lobby(room) {
    fan(room, {
        type: 'lobby',
        code: room.code,
        host: room.host,
        mode: room.mode,
        quick: room.quick,

        members: room.members.map(id => {
            const client = clients.get(id);

            return {
                id,
                name: client ? client.name : 'Ranger',
                team: client ? client.team : 0
            };
        })
    });
}

// ============================================================
// 6. PLAYER ROOM MANAGEMENT
// ============================================================

function leave(client) {
    const room = rooms.get(client.room);

    if (!room) {
        client.room = null;
        return;
    }

    room.members = room.members.filter(
        id => id !== client.id
    );

    // Eliminate disconnected player from active match
    if (room.game) {
        const player = room.game.players.find(
            p => p.id === client.id
        );

        if (player) {
            room.game.hurt(player, 10000, null);
        }
    }

    if (room.members.length === 0) {
        rooms.delete(room.code);
    } else {
        // Transfer room ownership
        if (room.host === client.id) {
            room.host = room.members[0];
        }

        if (!room.game) {
            lobby(room);
        }
    }

    client.room = null;
}

// ============================================================
// 7. START MULTIPLAYER MATCH
// ============================================================

function start(room) {
    if (room.members.length < 2) {
        return false;
    }

    const teamSet = new Set(
        room.members.map(id => clients.get(id)?.team)
    );

    if (teamSet.size < 2) {
        fan(room, {
            type: 'error',
            message: 'Choose at least two different teams before starting.'
        });

        return false;
    }

    room.game = new Game({
        mode: room.mode
    });

    const teamIndex = new Map();

    for (let index = 0; index < room.members.length; index++) {
        const id = room.members[index];
        const client = clients.get(id);

        if (!client) continue;

        const player = room.game.add(
            id,
            client.name,
            client.team
        );

        if (!teamIndex.has(client.team)) {
            teamIndex.set(client.team, teamIndex.size);
        }

        const angle = teamIndex.get(client.team) * 2.39996;

        player.x =
            Math.sin(angle) * 110 + (index % 2) * 3;

        player.z = Math.cos(angle) * 110;

        const startX = player.x;
        const startZ = player.z;

        // Prevent spawning inside obstacles
        for (
            let k = 0;
            room.game.blocked(player.x, player.z, 0.7) &&
            k < 150;
            k++
        ) {
            const a = k * 2.39996;
            const radius = 1 + k * 0.15;

            player.x = startX + Math.cos(a) * radius;
            player.z = startZ + Math.sin(a) * radius;
        }

        player.y = height(player.x, player.z);
    }

    const snapshot = room.game.snapshot();

    for (const id of room.members) {
        const client = clients.get(id);

        if (client) {
            send(client, {
                type: 'start',
                id: client.id,
                state: snapshot
            });
        }
    }

    room.last = Date.now();

    console.log(
        `Match started: ${room.code} | Mode: ${room.mode} | Players: ${room.members.length}`
    );

    return true;
}

// ============================================================
// 8. WEBSOCKET CONNECTION HANDLING
// ============================================================

wss.on('connection', ws => {

    if (clients.size >= MAX_CLIENTS) {
        ws.close(1013, 'Server capacity reached');
        return;
    }

    const id = crypto.randomBytes(5).toString('hex');

    const client = {
        id,
        ws,
        name: 'Ranger',
        room: null,
        team: 0,
        count: 0,
        window: Date.now(),
        alive: true
    };

    clients.set(id, client);

    send(client, {
        type: 'welcome',
        id
    });

    ws.on('pong', () => {
        client.alive = true;
    });

    // ========================================================
    // 9. HANDLE PLAYER MESSAGES
    // ========================================================

    ws.on('message', raw => {

        try {
            const now = Date.now();

            // Rate limiting
            if (now - client.window > 1000) {
                client.count = 0;
                client.window = now;
            }

            if (++client.count > 100) {
                return;
            }

            const message = JSON.parse(raw.toString());

            if (
                !message ||
                typeof message !== 'object' ||
                Array.isArray(message)
            ) {
                return;
            }

            // ------------------------------------------------
            // GET AVAILABLE ROOMS
            // ------------------------------------------------

            if (message.type === 'rooms') {
                send(client, {
                    type: 'rooms',

                    rooms: [...rooms.values()]
                        .filter(room => !room.game)
                        .map(room => ({
                            code: room.code,
                            mode: room.mode,
                            count: room.members.length,
                            quick: room.quick
                        }))
                });

                return;
            }

            // ------------------------------------------------
            // CREATE / JOIN / QUICK MATCHMAKING
            // ------------------------------------------------

            if (
                message.type === 'create' ||
                message.type === 'join' ||
                message.type === 'quick'
            ) {
                leave(client);

                client.name = String(
                    message.name || 'Ranger'
                )
                    .replace(/[<>\u0000-\u001f]/g, '')
                    .slice(0, 18) || 'Ranger';

                const mode = [
                    'solo',
                    'duo',
                    'squad'
                ].includes(message.mode)
                    ? message.mode
                    : 'solo';

                let room;

                // JOIN EXISTING ROOM
                if (message.type === 'join') {
                    room = rooms.get(
                        String(message.code || '').toUpperCase()
                    );

                    if (!room) {
                        return send(client, {
                            type: 'error',
                            message: 'Room not found. Check the six-character code.'
                        });
                    }
                }

                // QUICK MATCHMAKING
                else if (message.type === 'quick') {
                    room = [...rooms.values()].find(r =>
                        r.quick &&
                        !r.game &&
                        r.mode === mode &&
                        r.members.length < MAX_ROOM_MEMBERS
                    );
                }

                // CREATE NEW ROOM
                if (!room) {
                    let code;

                    do {
                        code = crypto
                            .randomBytes(3)
                            .toString('hex')
                            .toUpperCase();
                    } while (rooms.has(code));

                    room = {
                        code,
                        mode,
                        members: [],
                        host: id,
                        game: null,
                        quick: message.type === 'quick',
                        created: Date.now()
                    };

                    rooms.set(code, room);
                }

                if (
                    room.game ||
                    room.members.length >= MAX_ROOM_MEMBERS
                ) {
                    return send(client, {
                        type: 'error',
                        message: 'That match has started or the room is full.'
                    });
                }

                const team = room.mode === 'solo'
                    ? Date.now() + room.members.length
                    : (
                        Number.isInteger(message.team) &&
                        message.team >= 0 &&
                        message.team < 8
                    )
                        ? message.team
                        : room.members.length % 2;

                const teamCapacity =
                    room.mode === 'duo' ? 2 :
                    room.mode === 'squad' ? 4 : 1;

                const teamCount = room.members.filter(memberId => {
                    const member = clients.get(memberId);
                    return member && member.team === team;
                }).length;

                if (teamCount >= teamCapacity) {
                    return send(client, {
                        type: 'error',
                        message: 'That team is full. Choose another team.'
                    });
                }

                client.room = room.code;
                client.team = team;

                room.members.push(id);

                lobby(room);

                console.log(
                    `Player joined: ${client.name} | Room: ${room.code}`
                );

                return;
            }

            // ------------------------------------------------
            // LEAVE ROOM
            // ------------------------------------------------

            if (message.type === 'leave') {
                leave(client);
                return;
            }

            const room = rooms.get(client.room);

            if (!room) {
                return;
            }

            // ------------------------------------------------
            // START MATCH
            // ------------------------------------------------

            if (
                message.type === 'start' &&
                room.host === client.id &&
                !room.game
            ) {
                if (!start(room)) {
                    send(client, {
                        type: 'error',
                        message: 'At least two human players on opposing teams are required.'
                    });
                }
            }

            // ------------------------------------------------
            // PLAYER INPUT
            // ------------------------------------------------

            if (message.type === 'input' && room.game) {
                const player = room.game.players.find(
                    p => p.id === client.id
                );

                if (!player?.alive) {
                    return;
                }

                const input = message.input || {};
                const previous = player.input || {};

                player.input = {
                    forward: Math.max(
                        -1,
                        Math.min(1, Number(input.forward) || 0)
                    ),

                    right: Math.max(
                        -1,
                        Math.min(1, Number(input.right) || 0)
                    ),

                    yaw: Number.isFinite(input.yaw)
                        ? input.yaw : 0,

                    pitch: Number.isFinite(input.pitch)
                        ? input.pitch : 0,

                    aim: !!input.aim,
                    fire: !!input.fire,
                    sprint: !!input.sprint
                };

                // Preserve existing engine input behavior
                for (const key of [
                    'jump',
                    'reload',
                    'heal',
                    'interact',
                    'grenade'
                ]) {
                    player.input[key] =
                        !!input[key] || !!previous[key];
                }

                if (
                    Number.isInteger(input.slot) &&
                    input.slot >= 0 &&
                    input.slot < 3
                ) {
                    player.input.slot = input.slot;
                } else {
                    player.input.slot = previous.slot;
                }
            }

        } catch (error) {
            console.error(
                'Message processing error:',
                error.message
            );

            send(client, {
                type: 'error',
                message: 'Invalid request.'
            });
        }
    });

    // ========================================================
    // 10. DISCONNECTION
    // ========================================================

    ws.on('close', () => {
        leave(client);
        clients.delete(id);

        console.log(`Player disconnected: ${id}`);
    });

    ws.on('error', error => {
        console.error(
            `WebSocket error (${id}):`,
            error.message
        );
    });
});

// ============================================================
// 11. AUTHORITATIVE GAME LOOP - 30 FPS
// ============================================================

let ticks = 0;

const loop = setInterval(() => {
    const now = Date.now();

    for (const room of rooms.values()) {

        // QUICK MATCH COUNTDOWN
        if (!room.game) {

            if (
                room.quick &&
                room.members.length >= 2
            ) {
                room.countdown =
                    room.countdown || now + 8000;

                if (now >= room.countdown) {
                    start(room);
                }
            } else {
                room.countdown = 0;
            }

            continue;
        }

        // SIMULATION
        const dt = Math.min(
            0.075,
            (now - room.last) / 1000
        );

        room.last = now;

        room.game.step(dt);

        // Broadcast state at 15 FPS
        if (ticks % STATE_BROADCAST_INTERVAL === 0) {
            fan(room, {
                type: 'state',
                state: room.game.snapshot()
            });
        }
    }

    ticks++;

}, 1000 / TICK_RATE);

// ============================================================
// 12. WEBSOCKET HEARTBEAT
// ============================================================

const heartbeat = setInterval(() => {

    for (const client of clients.values()) {

        if (!client.alive) {
            client.ws.terminate();
        } else {
            client.alive = false;
            client.ws.ping();
        }
    }

}, 15000);

// ============================================================
// 13. START SERVER
// ============================================================

server.listen(PORT, '0.0.0.0', () => {

    console.log('======================================');
    console.log('       LASTLIGHT GAME SERVER');
    console.log('======================================');

    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Port: ${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log('WebSocket: Same host and port');
    console.log('Status: READY');
    console.log('======================================');

});

// ============================================================
// 14. GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

function shutdown(signal) {

    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`\nLASTLIGHT shutting down (${signal})...`);

    clearInterval(loop);
    clearInterval(heartbeat);

    for (const client of clients.values()) {
        client.ws.close(1001, 'Server shutting down');
    }

    wss.close(() => {
        server.close(() => {
            console.log('LASTLIGHT server stopped.');
            process.exit(0);
        });
    });

    // Prevent hanging indefinitely
    setTimeout(() => {
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
