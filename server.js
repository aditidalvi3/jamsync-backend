// --- Load Environment Variables ---
require('dotenv').config();

// --- Core Dependencies ---
const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const { Server } = require('socket.io');
const { URLSearchParams } = require('url');

// --- Room Management Helpers ---
const {
  addUserToRoom,
  removeUserFromRoom,
  getUsersInRoom,
} = require('./rooms');

// --- Express Setup ---
const app = express();
const server = http.createServer(app);

// --- CORS & JSON Middleware ---
app.use(cors({
  origin: ['http://localhost:3000', 'https://jamsync-frontend.vercel.app'],
  credentials: true,
}));
app.use(express.json());

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://jamsync-frontend.vercel.app'],
    methods: ['GET', 'POST'],
  },
});

// --- Routes ---

// 🔒 Step 1: Redirect user to Spotify Authorization
app.get('/login', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'user-modify-playback-state',
    'user-read-playback-state',
    'streaming',
  ];

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes.join(' '),
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// 🔑 Step 2: Spotify Callback to exchange code for tokens
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
    });

    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    res.redirect(
      `https://jamsync-frontend.vercel.app/callback?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`
    );
  } catch (error) {
    console.error('Error exchanging code:', error.response?.data || error.message);
    res.status(500).send('Failed to retrieve access token');
  }
});

// 🔄 Step 3: Refresh Token Endpoint
app.post('/refresh_token', async (req, res) => {
  const refresh_token = req.body.refresh_token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: process.env.SPOTIFY_CLIENT_ID,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
  });

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
    res.status(500).send('Failed to refresh token');
  }
});

// ✅ Health Check
app.get('/', (req, res) => {
  res.send('🎵 JamSync backend is running');
});

// --- WebSocket Logic ---
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    addUserToRoom(roomId, socket.id);
    console.log(`👤 ${username || socket.id} joined room ${roomId}`);

    socket.to(roomId).emit('user-joined', username || socket.id);
    io.in(roomId).emit('room-users', getUsersInRoom(roomId));
  });

  socket.on('chat-message', ({ roomId, message, sender }) => {
    io.in(roomId).emit('chat-message', {
      sender: sender || 'Anonymous',
      message,
      timestamp: new Date().toISOString(),
    });
  });

  // WebRTC Signaling
  socket.on('offer', (data) => socket.to(data.roomId).emit('offer', data));
  socket.on('answer', (data) => socket.to(data.roomId).emit('answer', data));
  socket.on('ice-candidate', (data) => socket.to(data.roomId).emit('ice-candidate', data));

  socket.on('disconnecting', () => {
    const rooms = [...socket.rooms].filter((r) => r !== socket.id);
    rooms.forEach((roomId) => {
      removeUserFromRoom(roomId, socket.id);
      socket.to(roomId).emit('user-left', socket.id);
      io.in(roomId).emit('room-users', getUsersInRoom(roomId));
    });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 JamSync backend running at http://localhost:${PORT}`);
});
