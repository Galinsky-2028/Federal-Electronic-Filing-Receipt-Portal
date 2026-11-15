import {
  EngineContractError, MAX_ENGINE_RESPONSE_BYTES, parseEngineLiveness, parseEngineReadiness,
} from "./contract.mjs";

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
export const DEFAULT_ENGINE_TIMEOUT_MS = 5000;

/**
 * Validates an operator-supplied Secure Intake base URL. HTTPS is required
 * except for loopback development. Credentials, query, fragment and paths
 * other than "/" are rejected so no secret or routing hint hides in the URL.
 */
export function parseEngineBaseUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) throw new EngineContractError("BASE_URL");
  let url;
  try { url = new URL(raw); } catch { throw new EngineContractError("BASE_URL"); }
  const loopback = LOOPBACK.has(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new EngineContractError("BASE_URL");
  return url.origin;
}

async function boundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ENGINE_RESPONSE_BYTES)
    throw new EngineContractError("RESPONSE_SIZE");
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new EngineContractError("RESPONSE_CONTENT_TYPE");
  const reader = response.body?.getReader();
  if (!reader) throw new EngineContractError("RESPONSE_SHAPE");
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ENGINE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new EngineContractError("RESPONSE_SIZE");
    }
    chunks.push(value);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new EngineContractError("RESPONSE_ENCODING"); }
}

async function get(fetchImpl, origin, path, timeoutMs) {
  const response = await fetchImpl(origin + path, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  return { status: response.status, text: await boundedText(response) };
}

/**
 * Probes the pinned engine's liveness and readiness. Returns a coarse state:
 * "ready", "not_ready", "unavailable" (network/timeout) or
 * "contract_mismatch" (wrong service, version drift, malformed response).
 * Raw upstream errors are never returned, so they cannot leak to callers.
 */
export async function probeEngine({ baseUrl, lock, fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS }) {
  const origin = parseEngineBaseUrl(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    throw new EngineContractError("TIMEOUT");
  try {
    const live = await get(fetchImpl, origin, "/api/health", timeoutMs);
    parseEngineLiveness(live.status, live.text, lock);
    const ready = await get(fetchImpl, origin, "/api/ready", timeoutMs);
    const readiness = parseEngineReadiness(ready.status, ready.text, lock);
    return Object.freeze({ state: readiness.ready ? "ready" : "not_ready", database: readiness.database });
  } catch (error) {
    if (error instanceof EngineContractError)
      return Object.freeze({ state: "contract_mismatch", code: error.code });
    return Object.freeze({ state: "unavailable" });
  }
}
