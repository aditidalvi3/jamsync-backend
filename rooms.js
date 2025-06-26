// rooms.js
const rooms = {};

function addUserToRoom(roomId, socketId) {
  if (!rooms[roomId]) rooms[roomId] = new Set();
  rooms[roomId].add(socketId);
}

function removeUserFromRoom(roomId, socketId) {
  if (rooms[roomId]) {
    rooms[roomId].delete(socketId);
    if (rooms[roomId].size === 0) {
      delete rooms[roomId]; // Clean up empty rooms
    }
  }
}

function getUsersInRoom(roomId) {
  return rooms[roomId] ? Array.from(rooms[roomId]) : [];
}

module.exports = {
  addUserToRoom,
  removeUserFromRoom,
  getUsersInRoom,
};
