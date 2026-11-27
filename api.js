const host = "https://api.omni.testnet.variational.io";
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export function normalizeKey(value) {
  const key = value.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw Error("Ключ должен содержать 64 шестнадцатеричных символа.");
  return key;
}

export async function request(credentials, method, path, payload) {
  const publicKey = "0x" + normalizeKey(credentials.publicKey);
  const seed = normalizeKey(credentials.seed);
  const pkcs8 = Uint8Array.from(("302e020100300506032b657004220420" + seed).match(/../g), (byte) => parseInt(byte, 16));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const timestamp = String(Date.now());
  const canonical = ["variational-omni-api/v1", "testnet", publicKey, timestamp, method, path, hash].join("\n");
  const signature = hex(await crypto.subtle.sign("Ed25519", key, encoder.encode(canonical)));
  const response = await fetch(host + path, {
    method,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      "x-variational-key": publicKey,
      "x-request-timestamp-ms": timestamp,
      "x-variational-signature": "0x" + signature,
      ...(body && {"Content-Type": "application/json"})
    },
    body: body || undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = Error([response.status, data?.error_code, data?.error_message].filter(Boolean).join(" · "));
    error.code = data?.error_code;
    error.status = response.status;
    error.retry = Math.max(Number(data?.retry_after_ms) || 0, (Number(response.headers.get("Retry-After")) || 0) * 1000);
    throw error;
  }
  if (data === null) throw Error("API вернул ответ без JSON.");
  return data;
}
