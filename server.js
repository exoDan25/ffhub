// server.js
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws"; // for ElevenLabs client
import fetch from "node-fetch";
import { decodeUlawToPCM16, encodePCM16ToUlawBase64 } from "./transcode.js";
console.log("🔑 ELEVENLABS_API_KEY:", process.env.ELEVENLABS_API_KEY ? "Loaded" : "Missing");
console.log("🤖 ELEVENLABS_AGENT_ID:", process.env.ELEVENLABS_AGENT_ID);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Relay server running...");
});

// WebSocket server for Twilio
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("🔎 Upgrade request:", req.url);
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from:", req.socket.remoteAddress);

  let streamSid = null;

  // Connect to ElevenLabs Convai Agent
  const elevenlabsWS = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/agent/${process.env.ELEVENLABS_AGENT_ID}/stream`,
    {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    }
  );

  elevenlabsWS.on("open", () => {
    console.log("✅ Connected to ElevenLabs Convai Agent");

    // Send session configuration once connected
    elevenlabsWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "Rachel", // change to your preferred voice
          model: "eleven_monolingual_v1",
          input_audio_format: { type: "pcm16" },
          output_audio_format: { type: "pcm16" },
        },
      })
    );
  });

  elevenlabsWS.on("error", (err) => {
    console.error("❌ ElevenLabs error:", err.message);
  });

  // Handle messages from Twilio
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("📞 Call started:", streamSid);
      } else if (msg.event === "media") {
        console.log("🎙️ Got audio chunk from Twilio");
        const pcm = decodeUlawToPCM16(msg.media.payload);
        elevenlabsWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Array.from(pcm),
          })
        );
      } else if (msg.event === "stop") {
        console.log("🛑 Call ended");
        elevenlabsWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        twilioWS.close();
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio message:", err.message);
    }
  });

  // Handle messages from ElevenLabs
  elevenlabsWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "audio") {
        console.log("🔊 Got audio from ElevenLabs");
        const pcmChunk = new Int16Array(msg.audio);
        const ulawB64 = encodePCM16ToUlawBase64(pcmChunk);
        twilioWS.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulawB64 },
          })
        );
      } else if (msg.type === "result") {
        console.log("🤖 AI Result:", msg.data);

        fetch(`${process.env.N8N_URL}/webhook/agent-results`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.data),
        }).catch((err) =>
          console.error("❌ Failed to send results to N8N:", err.message)
        );
      } else {
        console.log("📩 ElevenLabs message type:", msg.type);
      }
    } catch (err) {
      console.error("❌ Error parsing ElevenLabs message:", err.message);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket disconnected");
  });

  twilioWS.on("error", (err) => {
    console.error("❌ Twilio WebSocket error:", err.message);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Relay listening on ${port}`);
});
