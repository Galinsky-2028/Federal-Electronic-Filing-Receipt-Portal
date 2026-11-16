import { publicShellResponse } from "./public-shell.mjs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { healthResponse, readinessResponse } from "./health.mjs";
import { federalPrototypePolicy } from "./policy/federal-policy.mjs";
import { loadAgencyRegistry, isAgencyRegistry, RegistryError } from "./policy/agency-registry.mjs";
import { createDemoHandler, DEMO_CSP, isDemoPath } from "./demo/routes.mjs";
import { createDemoRuntime } from "./demo/runtime.mjs";

export function routePath(raw) {
  if (typeof raw !== "string" || raw.length === 0 ||
      !raw.startsWith("/") || raw.startsWith("//") ||
      /[\\\x00-\x1f\x7f]/.test(raw)) {
    return { status: 400, error: "invalid_request_target" };
  }
  if (raw.length > 2048) return { status: 414, error: "request_target_too_long" };
  try {
    const url = new URL(raw, "http://portal.invalid");
    if (url.origin !== "http://portal.invalid" || url.search || url.hash ||
        url.pathname !== raw) {
      return { status: 400, error: "invalid_request_target" };
    }
    return { path: url.pathname };
  } catch {
    return { status: 400, error: "invalid_request_target" };
  }
}

const unconfiguredDemo = createDemoHandler({ backend: null, auth: null });

export function createPortalServer({ agencyRegistry = null, clock = Date.now, demo = null } = {}) {
  if (typeof clock !== "function" ||
      agencyRegistry !== null && !isAgencyRegistry(agencyRegistry) ||
      demo !== null && typeof demo?.handler !== "function")
    throw new TypeError("Invalid portal configuration");
  const server = createServer(async (req, res) => {
    const target = routePath(req.url);
    let response;
    let csp = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    if (target.status) {
      response = { status: target.status, body: { error: target.error } };
    } else if (target.path === "/api/health") {
      response = healthResponse(target.path, req.method);
    } else if (target.path === "/api/ready") {
      response = demo && req.method === "GET"
        ? await demoReadiness(demo)
        : readinessResponse(target.path, req.method);
    } else if (isDemoPath(target.path)) {
      csp = DEMO_CSP;
      response = await (demo?.handler ?? unconfiguredDemo)(req, target.path, req.method);
    } else if (target.path === "/api/policy") {
      response = req.method === "GET"
        ? { status: 200, body: federalPrototypePolicy() }
        : { status: 405, body: { error: "method_not_allowed" } };
    } else if (target.path === "/api/agencies") {
      if (req.method !== "GET") {
        response = { status: 405, body: { error: "method_not_allowed" } };
      } else if (!agencyRegistry) {
        response = { status: 503, body: { schemaVersion: 1, status: "unconfigured",
          filingsAccepted: false, agencies: [] } };
      } else {
        try { response = { status: 200, body: agencyRegistry.snapshot(clock()) }; }
        catch (error) {
          response = { status: 503, body: { schemaVersion: 1, status: "unavailable",
            reason: error instanceof RegistryError &&
              ["REGISTRY_EXPIRED", "REGISTRY_CLOCK_ROLLBACK", "REGISTRY_INVALID_CLOCK"].includes(error.code)
              ? error.code : "REGISTRY_UNAVAILABLE",
            filingsAccepted: false, agencies: [] } };
        }
      }
    } else {
      response = publicShellResponse(target.path, req.method, { agencyRegistry, clock, demoEnabled: demo !== null })
        ?? { status: 404, body: { error: "not_found" } };
    }
    res.writeHead(response.status, {
      "content-type": response.contentType ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": csp,
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "x-frame-options": "DENY",
      ...(response.headers ?? {}),
      ...(response.status === 405 ? { allow: response.allow ?? "GET" } : {}),
    });
    res.end(response.headOnly || req.method === "HEAD" ? undefined : response.rawBody ?? JSON.stringify(response.body));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  server.maxHeadersCount = 64;
  return server;
}

async function demoReadiness(demo) {
  const ok = await demo.ready();
  return { status: ok ? 200 : 503, body: { schemaVersion: 1, service: "federal-electronic-filing-receipt-portal",
    ready: ok, reason: ok ? "demo_backend_ready" : "demo_storage_unavailable", backend: "portal-local-demo",
    upstream: "secure-intake-not-integrated", filingsAccepted: false, demoFilingsAccepted: ok } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("Invalid PORT");
  }
  const host = process.env.PORTAL_BIND_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new RangeError("Invalid PORTAL_BIND_HOST");
  }
  const registryPath = process.env.PORTAL_AGENCY_REGISTRY;
  const registryDigest = process.env.PORTAL_AGENCY_REGISTRY_SHA256;
  const minimumRevision = Number(process.env.PORTAL_AGENCY_REGISTRY_MIN_REVISION ?? 1);
  let agencyRegistry = null;
  if (registryPath !== undefined || registryDigest !== undefined) {
    if (!registryPath || !registryDigest) throw new Error("Registry path and digest must both be configured");
    agencyRegistry = await loadAgencyRegistry(registryPath, {
      expectedSha256: registryDigest, minimumRevision,
    });
  }
  const demo = await createDemoRuntime(process.env);
  createPortalServer({ agencyRegistry, demo }).listen(port, host);
}
