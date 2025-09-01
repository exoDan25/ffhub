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

// ---------- helpers ----------

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

// Slice an Int16Array into 20ms frames for Twilio: 160 samples @ 8kHz
function* sliceIntoFrames(int16_8k, samplesPerFrame = 160) {
  for (let i = 0; i < int16_8k.length; i += samplesPerFrame) {
    yield int16_8k.subarray(i, Math.min(i + samplesPerFrame, int16_8k.length));
  }
}

// ---------- get signed URL for ElevenLabs Agent WS ----------
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

// ---------- HTTP (health) & WS upgrade ----------
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

// ---------- main bridging logic ----------
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
    // You may send conversation_initiation_client_data here if needed.
  });

  // ElevenLabs -> Twilio (agent audio to caller)
  eleven.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "ping") return;

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        // EL sends PCM16 16kHz -> downsample to 8k, μ-law, 20ms frames
        const pcm16_16k = base64ToInt16(msg.audio_event.audio_base_64);
        const pcm16_8k  = downsample2x(pcm16_16k);

        for (const frame of sliceIntoFrames(pcm16_8k, 160)) {
          const ulawB64 = encodePCM16ToUlawBase64(frame);
          if (callStreamSid && twilioWS.readyState === 1) {
            twilioWS.send(JSON.stringify({
              event: "media",
              streamSid: callStreamSid,
              media: { payload: ulawB64 },
            }));
          }
        }
        console.log("🔊 Got audio from ElevenLabs → sent to Twilio");
      } else if (msg.type === "agent_response") {
        console.log("📩 ElevenLabs message: agent_response");
      } else {
        console.log("📩 ElevenLabs message:", msg.type);
      }
    } catch (e) {
      console.error("❌ ElevenLabs message parse error:", e.message);
    }
  });

  eleven.on("error", (e) => console.error("❌ ElevenLabs WS error:", e.message));
  eleven.on("close", (c, r) => console.error("❌ ElevenLabs closed:", c, r?.toString?.() || ""));

  // Twilio -> ElevenLabs (caller audio to agent)
  twilioWS.on("message", (buf) => {
    try {
      const data = JSON.parse(buf.toString());

      if (data.event === "start") {
        callStreamSid = data.start?.streamSid;
        console.log("📞 Call started:", callStreamSid);
        // kick off first response prompt shortly after start
        setTimeout(() => {
          if (eleven?.readyState === 1) {
            eleven.send(JSON.stringify({ type: "response.create" }));
            console.log("🪄 response.create");
          }
        }, 300);
        return;
      }

      if (data.event === "media" && data.media?.payload) {
        // μ-law 8k base64 -> PCM16 8k -> upsample to 16k -> base64 PCM16
        const pcm16_8k  = decodeUlawToPCM16(data.media.payload);
        const pcm16_16k = upsample2x(pcm16_8k);
        const b64       = int16ToBase64PCM(pcm16_16k);

        // send user audio chunk to EL
        if (eleven?.readyState === 1) {
          eleven.send(JSON.stringify({ type: "user_audio_chunk", audio: b64 }));
        }

        // roughly every ~1.2s ask EL to speak
        const now = Date.now();
        if (now - lastCreateAt > CREATE_INTERVAL_MS && eleven?.readyState === 1) {
          lastCreateAt = now;
          eleven.send(JSON.stringify({ type: "response.create" }));
          console.log("🪄 response.create");
        }
        return;
      }

      if (data.event === "stop") {
        console.log("🛑 Call ended");
        if (eleven?.readyState === 1) {
          eleven.send(JSON.stringify({ type: "response.create" })); // finalization
        }
        try { twilioWS.close(); } catch {}
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
