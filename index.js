import { createServer } from 'http';
import { Server } from "socket.io";
import { gameRoom } from "./gameRooms.js";
import { instrument } from "@socket.io/admin-ui";
import handler from 'serve-handler';
import dotenv from "dotenv";

dotenv.config();
const port = process.env.PORT || 3031;
const app = createServer((request, response) => {
  return handler(request, response, {
    "public": "node_modules/@socket.io/admin-ui/ui/dist"
  });
})
const io = new Server(app, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true
});

gameRoom(io);

app.listen(port, () => {
  console.log('Socket.io server has started on port', port);
});