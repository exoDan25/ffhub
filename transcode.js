import { decode, encode } from "mulaw-js";

// Convert μ-law (base64) → PCM16
export function decodeUlawToPCM16(base64) {
  const ulaw = Buffer.from(base64, "base64");
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    pcm[i] = decode(ulaw[i]);
  }
  return pcm;
}

// Convert PCM16 → μ-law (base64)
export function encodePCM16ToUlawBase64(pcm) {
  const ulaw = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    ulaw[i] = encode(pcm[i]);
  }
  return ulaw.toString("base64");
}
