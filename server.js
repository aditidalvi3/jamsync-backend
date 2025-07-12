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
const allowedOrigins = [
  'http://localhost:3000',                       // Local
  process.env.FRONTEND_URL                       // Vercel frontend
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  credentials: true,
}));
app.use(express.json());

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// --- Routes ---

// 🔒 Redirect user to Spotify Authorization
app.get('/login', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'user-modify-playback-state',
    'user-read-playback-state',
    'user-read-currently-playing',
  ];
  const redirectUri = `${process.env.BACKEND_URL}/callback`;

  res.redirect('https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: process.env.SPOTIFY_CLIENT_ID,
      scope: scopes.join(' '),
      redirect_uri: redirectUri,
    }).toString()
  );
});

// 🔒 Handle Spotify Callback
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const redirectUri = `${process.env.BACKEND_URL}/callback`;
  const frontendRedirect = process.env.FRONTEND_URL;

  const data = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: process.env.SPOTIFY_CLIENT_ID,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
  });

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = response.data;

    res.redirect(`${frontendRedirect}/callback?` +
      new URLSearchParams({
        access_token,
        refresh_token,
        expires_in,
      }).toString()
    );
  } catch (error) {
    console.error('Error fetching access token:', error.response?.data || error.message);
    res.status(500).send('Failed to get access token from Spotify.');
  }
});

// 👤 Get Spotify Profile
app.get('/profile', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  if (!accessToken) return res.status(401).send('No access token provided.');

  try {
    const { data } = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    res.json(data);
  } catch (error) {
    console.error('Error fetching profile:', error.response?.data || error.message);
    res.status(error.response?.status || 500).send('Failed to fetch Spotify profile.');
  }
});

// 🎵 Get Currently Playing Track
app.post('/update-now-playing', async (req, res) => {
  const { accessToken, roomId } = req.body;

  if (!accessToken || !roomId) {
    return res.status(400).send('Missing access token or room ID.');
  }

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 204) {
      io.in(roomId).emit('now-playing', null);
      return res.status(204).send();
    }

    const trackData = response.data.item;
    if (trackData?.type === 'track') {
      const track = {
        title: trackData.name,
        artist: trackData.artists.map(a => a.name).join(', '),
        albumArt: trackData.album.images[0].url,
      };
      io.in(roomId).emit('now-playing', track);
      res.json(track);
    } else {
      io.in(roomId).emit('now-playing', null);
      res.status(404).send('No track currently playing.');
    }
  } catch (error) {
    console.error('Now playing error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).send('Failed to fetch track.');
  }
});

// 🔄 Refresh Spotify Token
app.get('/refresh_token', async (req, res) => {
  const refreshToken = req.query.refresh_token;

  const data = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.SPOTIFY_CLIENT_ID,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
  });

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).send('Failed to refresh token');
  }
});

// --- WebSocket Handlers ---
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    addUserToRoom(roomId, socket.id);
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

  socket.on('offer', (data) => socket.to(data.roomId).emit('offer', data));
  socket.on('answer', (data) => socket.to(data.roomId).emit('answer', data));
  socket.on('ice-candidate', (data) => socket.to(data.roomId).emit('ice-candidate', data));

  socket.on('disconnecting', () => {
    const rooms = [...socket.rooms].filter((r) => r !== socket.id);
    rooms.forEach(roomId => {
      removeUserFromRoom(roomId, socket.id);
      socket.to(roomId).emit('user-left', socket.id);
    });
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
