// server.js
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws"; // ✅ needed for ElevenLabs client
import fetch from "node-fetch";
import { decodeUlawToPCM16, encodePCM16ToUlawBase64 } from "./transcode.js";

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
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWS) => {
  console.log("✅ Twilio WebSocket connected");

  let streamSid = null;

  // Connect to ElevenLabs Realtime API
  const elevenlabsWS = new WebSocket("wss://api.elevenlabs.io/v1/realtime", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });

  elevenlabsWS.on("open", () => {
    console.log("✅ Connected to ElevenLabs Realtime API");

    // ✅ Send session configuration to ElevenLabs
    elevenlabsWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "Rachel", // 👈 change to your preferred voice
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
        // Convert μ-law → PCM16 and send to ElevenLabs
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
      console.error("❌ Error parsing Twilio message:", err);
    }
  });

  // Handle messages from ElevenLabs
  elevenlabsWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "audio") {
        console.log("🔊 Got audio from ElevenLabs");
        // Convert PCM16 → μ-law and send back to Twilio
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

        // Forward results to N8N
        fetch(`${process.env.N8N_URL}/webhook/agent-results`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.data),
        }).catch((err) =>
          console.error("❌ Failed to send results to N8N:", err.message)
        );
      } else {
        console.log("📩 ElevenLabs message:", msg.type);
      }
    } catch (err) {
      console.error("❌ Error parsing ElevenLabs message:", err);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket disconnected");
  });
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Relay listening on ${port}`);
});
