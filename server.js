// server.js (ESM)
// Twilio Media Streams  <->  ElevenLabs ConvAI Agent (WS)

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

// ----- helpers -----
function upsample2x(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0, j = 0; i < int16_8k.length; i++) {
    const s = int16_8k[i];
    out[j++] = s;
    out[j++] = s;
  }
  return out;
}
function downsample2x(int16_16k) {
  const out = new Int16Array(Math.floor(int16_16k.length / 2));
  for (let i = 0, j = 0; i < out.length; i++, j += 2) out[i] = int16_16k[j];
  return out;
}
function int16ToB64PCM(int16) {
  const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  return buf.toString("base64");
}
function b64ToInt16(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}
async function getSignedUrl() {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVEN_AGENT}`,
    { headers: { "xi-api-key": ELEVEN_KEY } }
  );
  if (!r.ok) throw new Error(`get-signed-url ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data?.signed_url) throw new Error("No signed_url in response.");
  return data.signed_url;
}

// ----- HTTP + upgrade -----
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
  if (req.url === "/twilio") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});

// ----- main bridge -----
wss.on("connection", async (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from:", req.socket.remoteAddress);

  let streamSid = null;
  let gotCallerAudio = false;
  let lastCreateAt = 0;
  const CREATE_INTERVAL_MS = 1200;

  // Outbound pacing to Twilio (μ-law @8kHz)
  const FRAME_BYTES = 160; // 20ms μ-law
  const FRAME_MS = 20;
  const SILENCE_ULAW = 0xFF;
  let ulawBuffer = Buffer.alloc(0);
  let sendTimer = null;

  function startPacedSender() {
    if (sendTimer) return;
    sendTimer = setInterval(() => {
      if (!streamSid || twilioWS.readyState !== 1) return;

      let chunk;
      if (ulawBuffer.length >= FRAME_BYTES) {
        chunk = ulawBuffer.subarray(0, FRAME_BYTES);
        ulawBuffer = ulawBuffer.subarray(FRAME_BYTES);
      } else {
        const need = FRAME_BYTES - ulawBuffer.length;
        const pad = Buffer.alloc(need, SILENCE_ULAW);
        chunk = Buffer.concat([ulawBuffer, pad], FRAME_BYTES);
        ulawBuffer = Buffer.alloc(0);
      }

      if (twilioWS.bufferedAmount > 1_000_000) return; // backpressure guard

      twilioWS.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: chunk.toString("base64") },
      }));
    }, FRAME_MS);
  }
  function stopPacedSender() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    ulawBuffer = Buffer.alloc(0);
  }

  // Fresh signed URL per call
  let eleven;
  try {
    const signedUrl = await getSignedUrl();
    eleven = new WebSocket(signedUrl);
  } catch (e) {
    console.error("❌ Failed to get signed URL:", e.message);
    twilioWS.close();
    return;
  }

  eleven.on("open", () => {
    console.log("✅ Connected to ElevenLabs ConvAI Agent");
    // ⚡ Force initial greeting
    setTimeout(() => {
      if (eleven?.readyState === 1) {
        console.log("⚡ Forcing initial response.create");
        eleven.send(JSON.stringify({ type: "response.create" }));
      }
    }, 500);
  });

  eleven.on("unexpected-response", (req, res) => {
    console.error("❌ ElevenLabs unexpected response:", res.statusCode, res.statusMessage);
    res.on("data", (chunk) => console.error("Body:", chunk.toString()));
  });

  // ElevenLabs -> Twilio
  eleven.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) {
      console.error("❌ ElevenLabs message parse error:", e.message); return;
    }
    console.log("📩 ElevenLabs full message:", msg);

    const audioB64 = msg?.audio_event?.audio_base_64 || msg?.audio;
    if (msg.type === "audio" && audioB64) {
      const pcm16_16k = b64ToInt16(audioB64);
      const pcm16_8k  = downsample2x(pcm16_16k);
      const ulawB64   = encodePCM16ToUlawBase64(pcm16_8k);
      const bytes     = Buffer.from(ulawB64, "base64");
      ulawBuffer = Buffer.concat([ulawBuffer, bytes]);
    }
    if (msg.error) console.error("❌ ElevenLabs error:", msg.error);
  });

  eleven.on("error", (e) => console.error("❌ ElevenLabs WS error:", e.message));
  eleven.on("close", (c, r) => { console.error("❌ ElevenLabs closed:", c, r?.toString?.() || ""); stopPacedSender(); });

  // Twilio -> ElevenLabs
  let mediaCount = 0;
  twilioWS.on("message", (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch (e) {
      console.error("❌ Twilio message parse error:", e.message); return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      console.log("📞 Call started:", streamSid);
      startPacedSender();
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      mediaCount++;
      if (mediaCount % 50 === 0) console.log(`🎙️ Received ${mediaCount} audio chunks from Twilio`);

      const pcm16_8k  = decodeUlawToPCM16(data.media.payload);
      const pcm16_16k = upsample2x(pcm16_8k);
      const b64       = int16ToB64PCM(pcm16_16k);

      if (eleven?.readyState === 1) eleven.send(JSON.stringify({ type: "user_audio_chunk", audio: b64 }));

      if (!gotCallerAudio) {
        gotCallerAudio = true;
        setTimeout(() => {
          if (eleven?.readyState === 1) {
            console.log("⚡ Sending first response.create after caller audio");
            eleven.send(JSON.stringify({ type: "response.create" }));
            lastCreateAt = Date.now();
          }
        }, 300);
      } else {
        const now = Date.now();
        if (now - lastCreateAt > CREATE_INTERVAL_MS && eleven?.readyState === 1) {
          console.log("⚡ Sending periodic response.create");
          eleven.send(JSON.stringify({ type: "response.create" }));
          lastCreateAt = now;
        }
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Call ended");
      try { if (eleven?.readyState === 1) eleven.send(JSON.stringify({ type: "response.create" })); } catch {}
      twilioWS.close();
      stopPacedSender();
      return;
    }
  });

  twilioWS.on("close", () => { console.log("❌ Twilio WebSocket disconnected"); try { eleven?.close(); } catch {} stopPacedSender(); });
  twilioWS.on("error", (e) => console.error("❌ Twilio WS error:", e.message));
});

// start server
server.listen(PORT, "0.0.0.0", () => console.log(`Relay listening on ${PORT}`));
