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
    'user-read-playback-state', // ADDED: New scope for getting playback state
  ];
  const redirectUri = `${process.env.REACT_APP_BACKEND_URL}/callback`;

  // Note: Your backend login endpoint may be different based on your implementation
  res.redirect(`https://accounts.spotify.com/authorize?$` +
    `?response_type=code` +
    `&client_id=${process.env.SPOTIFY_CLIENT_ID}` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`);
});

// 🔒 Step 2: Handle Spotify Callback and get Access Token
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const redirectUri = `${process.env.REACT_APP_BACKEND_URL}/callback`;
  const credentials = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }), {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token } = response.data;
    const frontendRedirect = `${process.env.REACT_APP_FRONTEND_URL}/callback?access_token=${access_token}&refresh_token=${refresh_token}`;
    res.redirect(frontendRedirect);
  } catch (err) {
    console.error('Error during token exchange:', err.response ? err.response.data : err.message);
    res.status(500).send('Authentication failed.');
  }
});

// --- Socket.IO Connection & Events ---
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

  // NEW: Socket listener to get and broadcast the currently playing track
  socket.on('update-now-playing', async ({ roomId, accessToken }) => {
    if (!accessToken) return;

    try {
      const response = await axios.get('https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      // Spotify API returns a 204 No Content if nothing is playing
      if (response.status === 204) {
        io.in(roomId).emit('now-playing', null); // Emit null to clear the track
        return;
      }

      const trackData = response.data.item;
      if (trackData && trackData.type === 'track') {
        const track = {
          title: trackData.name,
          artist: trackData.artists.map(artist => artist.name).join(', '),
          albumArt: trackData.album.images[0].url,
        };
        // Broadcast the new track to everyone in the room
        io.in(roomId).emit('now-playing', track);
      } else {
        io.in(roomId).emit('now-playing', null); // Clear track if not a song
      }
    } catch (error) {
      console.error('Error fetching currently playing track:', error.response ? error.response.data : error.message);
    }
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
    });
  });
});

// --- Server Startup ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});