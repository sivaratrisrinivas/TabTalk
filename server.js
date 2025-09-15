// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

let _httpServer;
let _io;

function startServer(port = 3000) {
    const app = express();
    const server = http.createServer(app);
    const io = socketIo(server, {
        cors: {
          origin: '*', // Allow connections from any origin
          methods: ['GET', 'POST']
        }
    });

    // No static hosting: run your own static dev server (e.g., 5500)

    io.on('connection', (socket) => {
        console.log('A user connected');

        // Join a logical room
        socket.on('join', (room) => {
            try {
                socket.join(room);
                console.log(`Joined room: ${room}`);
                // Ack back to the client so tests/app can know join completed
                socket.emit('joined', room);
            } catch (_) {}
        });

        // Room-scoped signaling
        socket.on('message', (message) => {
            const room = message && message.room ? String(message.room) : '';
            const type = message && message.type;
            console.log('Received message:', type, 'room:', room || '(none)');
            if (room) {
                socket.to(room).emit('message', message);
            } else {
                // Fallback: broadcast (legacy)
                socket.broadcast.emit('message', message);
            }
        });

        socket.on('disconnect', () => {
            console.log('User disconnected');
        });
    });

    server.listen(port, () => console.log(`Signaling server listening on port ${port}`));
    _httpServer = server;
    _io = io;
    return { server, io };
}

async function stopServer() {
    if (_io) {
        await new Promise(res => _io.close(res));
        _io = undefined;
    }
    if (_httpServer) {
        await new Promise(res => _httpServer.close(res));
        _httpServer = undefined;
    }
}

if (require.main === module) {
    startServer(3000);
}

module.exports = { startServer, stopServer };