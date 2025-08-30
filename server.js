// server.js
import http from "http";
import { WebSocketServer } from "ws";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Relay server running...");
});

import { decodeUlawToPCM16, encodePCM16ToUlawBase64 } from "./transcode.js";

// When Twilio sends audio
if (msg.event === "media") {
  const pcm = decodeUlawToPCM16(msg.media.payload);
  elevenlabsWS.send(
    JSON.stringify({ type: "audio", audio: Array.from(pcm) })
  );
}

// When ElevenLabs sends audio
if (msg.type === "audio") {
  const pcmChunk = new Int16Array(msg.audio);
  const ulawB64 = encodePCM16ToUlawBase64(pcmChunk);
  twilioWS.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: ulawB64 },
    })
  );
}

// WebSocket server
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("✅ Twilio WebSocket connected");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("📩 Twilio event:", msg.event);

      if (msg.event === "start") {
        console.log("Call started:", msg.start.streamSid);
      } else if (msg.event === "media") {
        // Twilio sends audio chunks here
        // For now, just ignore them
      } else if (msg.event === "stop") {
        console.log("Call ended");
      }
    } catch (err) {
      console.error("Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WebSocket disconnected");
  });
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Relay listening on ${port}`);
});
