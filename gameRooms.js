import { db } from "./sequelize.js";

const MAX_ROOM_SIZE = 5;

// Grace period before we migrate the host away from a disconnected player.
// Long enough that a simple page refresh (disconnect -> reconnect) won't
// trigger a host hand-off.
const GRACE_MS = 12000;
const migrationTimers = new Map();

// The room state is stored double-encoded in the DB (sync-state does
// JSON.stringify on the already-stringified client payload). Decode robustly.
function decodeState(dbState) {
  if (!dbState) return null;
  try {
    let v = JSON.parse(dbState);
    if (typeof v === "string") v = JSON.parse(v);
    return v;
  } catch (e) {
    return null;
  }
}

async function loadRoomObj(uuid) {
  const room = await db.rooms.findOne({ where: { uuid } });
  if (!room) return null;
  return decodeState(room.state);
}

// Persist (keeping the double-encoding convention) and broadcast to the room.
async function persistAndBroadcast(io, uuid, obj) {
  const single = JSON.stringify(obj); // clients single-parse state-changed
  await db.rooms.update(
    { state: JSON.stringify(single) }, // DB stays double-encoded
    { where: { uuid } }
  );
  io.to(uuid).emit("state-changed", { roomId: uuid, state: single });
}

// A socket dropped: mark its player offline, then after a grace period hand
// over the host role if that player was the host and hasn't come back.
async function handleSocketLeave(io, uuid, socketId) {
  const obj = await loadRoomObj(uuid);
  if (!obj || !Array.isArray(obj.players)) return;

  const player = obj.players.find((p) => p.socketid === socketId);
  if (!player) return;

  player.online = false;
  await persistAndBroadcast(io, uuid, obj);

  const pid = player.pid;
  const wasBoss = !!player.boss;
  const key = `${uuid}:${pid}`;
  if (migrationTimers.has(key)) clearTimeout(migrationTimers.get(key));
  const timer = setTimeout(() => {
    migrationTimers.delete(key);
    migrateHostIfGone(io, uuid, pid, wasBoss);
  }, GRACE_MS);
  migrationTimers.set(key, timer);
}

async function migrateHostIfGone(io, uuid, pid, wasBoss) {
  if (!wasBoss) return;
  const obj = await loadRoomObj(uuid);
  if (!obj || !Array.isArray(obj.players)) return;

  const player = obj.players.find((p) => p.pid === pid);
  if (!player || player.online) return; // gone for good but reconnected? skip
  if (!player.boss) return; // host already handed over elsewhere

  const heir = obj.players.find((p) => p.pid !== pid && p.online !== false);
  if (!heir) return; // nobody to promote

  player.boss = false;
  heir.boss = true;
  await persistAndBroadcast(io, uuid, obj);
}

export const gameRoom = (io) => {
  io.on("connection", (socket) => {
    console.log("Game room: connected", socket.id);

    // Fires while the socket is still a member of its rooms (unlike
    // "disconnect", where socket.rooms is already empty).
    socket.on("disconnecting", () => {
      const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
      rooms.forEach((uuid) => {
        handleSocketLeave(io, uuid, socket.id);
      });
    });

    socket.on("create-room", async (size = MAX_ROOM_SIZE, ack) => {
      try {
        const { uuid } = await db.rooms.create();
        socket.join(uuid);
        const allRooms = io.sockets.adapter.rooms;
        allRooms.get(uuid).roomSize = parseInt(size);
        ack({ status: "ok", roomId: uuid });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("join-room", async (uuid, ack) => {
      try {
        // A DB az igazság forrása: a szoba akkor is létezik, ha épp egy kliens
        // sincs bent (pl. a host átváltott egy másik appra és lecsatlakozott).
        // Az in-memory adapter szobát a socket.join() úgyis újra létrehozza.
        const room = await db.rooms.findOne({
          where: { uuid },
        });
        if (!room) {
          throw new Error("No such room id in database.");
        }

        // Már a szobában van a kliens
        if (socket.rooms.has(uuid)) {
          throw new Error("The client is already in this room.");
        }

        // Tele van a szoba (a roomSize az adapter szobán él; ha az újra
        // létrejön, MAX_ROOM_SIZE-ra esünk vissza alapértelmezésként).
        const allRooms = io.sockets.adapter.rooms;
        const existing = allRooms.get(uuid);
        const roomSize = (existing && existing.roomSize) || MAX_ROOM_SIZE;
        const currentSize = existing ? existing.size : 0;
        if (currentSize >= roomSize) {
          throw new Error("The room is already full.");
        }

        socket.join(uuid);
        // a roomSize-t újra rárakjuk az (esetleg most létrejött) adapter szobára
        allRooms.get(uuid).roomSize = roomSize;

        socket.broadcast
          .to(uuid)
          .emit("player-joined", { roomId: uuid, socketId: socket.id });
        if (allRooms.get(uuid).size === allRooms.get(uuid).roomSize) {
          const clients = Array.from(allRooms.get(uuid));
          clients.forEach((socketId, i) => {
            io.to(socketId).emit("room-is-full", {
              roomId: uuid,
              player: i + 1,
              state: room.state,
            });
          });
        }

        // visszaadás
        ack({ status: "ok", state: room.state });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("sync-state", async (uuid, state, broadcast, ack) => {
      try {
        // nincs ilyen szoba
        const allRooms = io.sockets.adapter.rooms;
        if (!Array.from(allRooms.keys()).includes(uuid)) {
          throw new Error("No such room id on the socket.io server.");
        }

        // szoba state lekérése
        // nincs benne db-ben a uuid, meghal a db query
        const room = await db.rooms.findOne({
          where: { uuid },
        });
        if (!room) {
          throw new Error("No such room id in database.");
        }

        // Nincs a szobában a kliens
        if (!socket.rooms.has(uuid)) {
          throw new Error("The client is not in this room.");
        }

        // db módosítás
        await db.rooms.update(
          { state: JSON.stringify(state) },
          { where: { uuid } }
        );

        // send to everybody
        let sender;
        if (broadcast) {
          sender = socket.broadcast.to(uuid);
        } else {
          sender = io.to(uuid);
        }
        sender.emit("state-changed", { roomId: uuid, state });

        ack({ status: "ok" });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("sync-action", async (uuid, action, broadcast, ack) => {
      try {
        // nincs ilyen szoba
        const allRooms = io.sockets.adapter.rooms;
        if (!Array.from(allRooms.keys()).includes(uuid)) {
          throw new Error("No such room id on the socket.io server.");
        }

        // Nincs a szobában a kliens
        if (!socket.rooms.has(uuid)) {
          throw new Error("The client is not in this room.");
        }

        // send to everybody
        let sender;
        if (broadcast) {
          sender = socket.broadcast.to(uuid);
        } else {
          sender = io.to(uuid);
        }
        sender.emit("action-sent", { roomId: uuid, action });

        ack({ status: "ok" });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("leave-room", async (uuid, ack) => {
      try {
        // nincs ilyen szoba
        const allRooms = io.sockets.adapter.rooms;
        if (!Array.from(allRooms.keys()).includes(uuid)) {
          throw new Error("No such room id on the socket.io server.");
        }

        // Nincs a szobában a kliens
        if (!socket.rooms.has(uuid)) {
          throw new Error("The client is not in this room.");
        }

        // broadcast
        socket.leave(uuid);
        socket.broadcast
          .to(uuid)
          .emit("player-left", { roomId: uuid, socketId: socket.id });

        ack({ status: "ok" });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("close-room", async (uuid, ack) => {
      try {
        // nincs ilyen szoba
        const allRooms = io.sockets.adapter.rooms;
        if (!Array.from(allRooms.keys()).includes(uuid)) {
          throw new Error("No such room id on the socket.io server.");
        }

        // Nincs a szobában a kliens
        if (!socket.rooms.has(uuid)) {
          throw new Error("The client is not in this room.");
        }

        // szoba state lekérése
        // nincs benne db-ben a uuid, meghal a db query
        const room = await db.rooms.findOne({
          where: { uuid },
        });
        if (!room) {
          throw new Error("No such room id in database.");
        }

        // szoba lezárása
        allRooms.get(uuid).roomSize = allRooms.get(uuid).size;

        // kliensek értesítése
        const clients = Array.from(allRooms.get(uuid));
        clients.forEach((socketId, i) => {
          io.to(socketId).emit("room-is-full", {
            roomId: uuid,
            player: i + 1,
            state: room.state,
          });
        });

        ack({ status: "ok", state: room.state });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });

    socket.on("get-state", async (uuid, ack) => {
      try {
        // nincs ilyen szoba
        const allRooms = io.sockets.adapter.rooms;
        if (!Array.from(allRooms.keys()).includes(uuid)) {
          throw new Error("No such room id on the socket.io server.");
        }

        // szoba state lekérése
        // nincs benne db-ben a uuid, meghal a db query
        const room = await db.rooms.findOne({
          where: { uuid },
        });
        if (!room) {
          throw new Error("No such room id in database.");
        }

        // Nincs a szobában a kliens
        if (!socket.rooms.has(uuid)) {
          throw new Error("The client is not in this room.");
        }

        ack({ status: "ok", state: room.state });
      } catch (e) {
        if (typeof ack === "function") {
          ack({ status: "error", message: e.message });
        }
      }
    });
  });
};
