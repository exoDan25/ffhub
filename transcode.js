// transcode.js
import { decode, encode } from "mulaw-js";

/**
 * Convert μ-law (base64) → PCM16 Int16Array
 * @param {string} base64 - Base64 encoded μ-law audio from Twilio
 * @returns {Int16Array} - PCM16 samples
 */
export function decodeUlawToPCM16(base64) {
  const ulaw = Buffer.from(base64, "base64");
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    pcm[i] = decode(ulaw[i]);
  }
  return pcm;
}

/**
 * Convert PCM16 Int16Array → μ-law (base64)
 * @param {Int16Array} pcm - PCM16 samples from ElevenLabs
 * @returns {string} - Base64 encoded μ-law audio for Twilio
 */
export function encodePCM16ToUlawBase64(pcm) {
  const ulaw = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    ulaw[i] = encode(pcm[i]);
  }
  return ulaw.toString("base64");
}
