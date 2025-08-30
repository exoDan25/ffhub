// server.js
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Relay server running...");
});

const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWS) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Connect to ElevenLabs Realtime API
  const elevenlabsWS = new WebSocket("wss://api.elevenlabs.io/v1/realtime", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });

  // Handle messages from Twilio
  twilioWS.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("Call started:", streamSid);
      elevenlabsWS.send(JSON.stringify({ type: "start" }));
    } else if (msg.event === "media") {
      // TODO: convert μ-law to PCM16 before sending
      elevenlabsWS.send(
        JSON.stringify({ type: "audio", audio: msg.media.payload })
      );
    } else if (msg.event === "stop") {
      console.log("Call ended");
      elevenlabsWS.send(JSON.stringify({ type: "stop" }));
      twilioWS.close();
    }
  });

  // Handle messages from ElevenLabs
  elevenlabsWS.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "audio") {
      // TODO: convert PCM16 back to μ-law for Twilio
      twilioWS.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.audio },
        })
      );
    } else if (msg.type === "result") {
      console.log("Result from AI:", msg.data);

      // Forward results to N8N
      fetch(`${process.env.N8N_URL}/webhook/agent-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      }).catch((err) =>
        console.error("Failed to send results to N8N:", err.message)
      );
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Relay listening on ${port}`);
});