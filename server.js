// server.js (ESM)
// Relay Twilio Media Streams <-> ElevenLabs ConvAI Agents (WebSocket)

import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import fetch from "node-fetch";
import { decodeUlawToPCM16, encodePCM16ToUlawBase64 } from "./transcode.js";

const PORT = process.env.PORT || 3000;
const ELEVEN_AGENT = process.env.ELEVENLABS_AGENT_ID;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;

console.log("🚀 Relay starting up...");
console.log("🤖 ELEVENLABS_AGENT_ID:", ELEVEN_AGENT);
console.log("🔑 ELEVENLABS_API_KEY:", ELEVEN_KEY ? "Loaded" : "Missing");

// --- helpers --------------------------------------------------------------

// naive 2x upsample: 8 kHz PCM16 -> 16 kHz PCM16 (duplicate samples)
function upsample2x(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0, j = 0; i < int16_8k.length; i++) {
    const s = int16_8k[i];
    out[j++] = s;
    out[j++] = s;
  }
  return out;
}

// naive 2x downsample: 16 kHz PCM16 -> 8 kHz PCM16 (drop every 2nd sample)
function downsample2x(int16_16k) {
  const out = new Int16Array(Math.floor(int16_16k.length / 2));
  for (let i = 0, j = 0; i < out.length; i++, j += 2) out[i] = int16_16k[j];
  return out;
}

// Int16Array -> base64 PCM16
function int16ToBase64PCM(int16) {
  const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  return buf.toString("base64");
}

// base64 -> Int16Array (PCM16)
function base64ToInt16(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

// --- signed URL for ElevenLabs Agent WS (ConvAI) -------------------------
// Docs: Agent WebSockets / message types (user_audio_chunk, response.create, audio, etc.)
let signedUrl;
async function getSignedUrl() {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVEN_AGENT}`,
    { headers: { "xi-api-key": ELEVEN_KEY } }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`get-signed-url ${r.status}: ${t}`);
  }
  const data = await r.json();
  if (!data?.signed_url) throw new Error("No signed_url in response.");
  signedUrl = data.signed_url;
  console.log("🔐 got signed URL for ElevenLabs.");
}
await getSignedUrl();

// --- HTTP (health) & WS upgrade ------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Relay server running...");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// --- main bridging logic --------------------------------------------------
wss.on("connection", (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from:", req.socket.remoteAddress);

  let callStreamSid = null;
  let eleven;               // WebSocket to ElevenLabs
  let lastCreateAt = 0;     // throttle response.create
  const CREATE_INTERVAL_MS = 1200; // ask for output ~1.2s cadence

  // connect to ElevenLabs ConvAI Agent
  eleven = new WebSocket(signedUrl);

  eleven.on("open", () => {
    console.log("✅ Connected to ElevenLabs ConvAI Agent");
    // Optional: you can send conversation_initiation_client_data here if you want to seed context.
    // (Message spec: see Agent WebSockets doc.)
  });

  eleven.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ping") {
        // keepalive from ElevenLabs
        // console.log("📩 ping");
      } else if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        // ElevenLabs sends PCM16 (16 kHz) base64 by default
        // Downsample to 8 kHz and μ-law encode for Twilio
        const pcm16_16k = base64ToInt16(msg.audio_event.audio_base_64);
        const pcm16_8k = downsample2x(pcm16_16k);
        const ulawB64 = encodePCM16ToUlawBase64(pcm16_8k);

        if (callStreamSid) {
          console.log("📤 Sending to Twilio:", JSON.stringify({
  event: "media",
  streamSid: callStreamSid,
  media: { payload: ulawB64 },
}).slice(0, 80) + "...");
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid: callStreamSid,
              media: { payload: ulawB64 },
            })
          );
        }
        console.log("🔊 Got audio from ElevenLabs → sent to Twilio");
      } else {
        console.log("📩 ElevenLabs message:", msg.type);
      }
    } catch (e) {
      console.error("❌ ElevenLabs message parse error:", e.message);
    }
  });

  eleven.on("error", (e) => console.error("❌ ElevenLabs WS error:", e.message));
  eleven.on("close", (c, r) => console.error("❌ ElevenLabs closed:", c, r?.toString?.() || ""));

  // Twilio -> ElevenLabs
  twilioWS.on("message", (buf) => {
    try {
      const data = JSON.parse(buf.toString());

      if (data.event === "start") {
        callStreamSid = data.start?.streamSid;
        console.log("📞 Call started:", callStreamSid);
        return;
      }

      if (data.event === "media" && data.media?.payload) {
        // 1) μ-law 8k base64 -> PCM16 8k
        const pcm16_8k = decodeUlawToPCM16(data.media.payload);
        // 2) upsample to 16k for ElevenLabs default
        const pcm16_16k = upsample2x(pcm16_8k);
        // 3) to base64
        const b64 = int16ToBase64PCM(pcm16_16k);

        // send user audio chunk (ConvAI Agent WS)
        const out = { type: "user_audio_chunk", audio: b64 };
        eleven?.readyState === 1 && eleven.send(JSON.stringify(out));

        // every ~1.2s, ask ElevenLabs to produce speech
        const now = Date.now();
        if (now - lastCreateAt > CREATE_INTERVAL_MS) {
          lastCreateAt = now;
          eleven?.readyState === 1 && eleven.send(JSON.stringify({ type: "response.create" }));
          console.log("🪄 response.create");
        }

        // (logging toned down)
        // console.log("📤 sent user_audio_chunk", pcm16_16k.length);
        return;
      }

      if (data.event === "stop") {
        console.log("🛑 Call ended");
        // Ask for a final response
        eleven?.readyState === 1 && eleven.send(JSON.stringify({ type: "response.create" }));
        twilioWS.close();
        return;
      }
    } catch (e) {
      console.error("❌ Twilio message parse error:", e.message);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket disconnected");
    try { eleven?.close(); } catch {}
  });
  twilioWS.on("error", (e) => console.error("❌ Twilio WS error:", e.message));
});

// start server
server.listen(PORT, "0.0.0.0", () => console.log(`Relay listening on ${PORT}`));
