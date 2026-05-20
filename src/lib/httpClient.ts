import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest,
} from "@protontech/drive-sdk";
import { fetch } from "./tauriFetch";

const APP_VERSION = import.meta.env.VITE_PROTON_APP_VERSION ?? "external-drive-protondrive-linux@0.1.0-alpha";

export function createHttpClient(
  getAccessToken: () => string | null,
  getUid: () => string | null,
): ProtonDriveHTTPClient {
  function baseHeaders(extra?: Headers): Headers {
    const headers = new Headers(extra);
    headers.set("x-pm-appversion", APP_VERSION);
    headers.set("Content-Type", "application/json");
    const token = getAccessToken();
    const uid = getUid();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (uid) headers.set("x-pm-uid", uid);
    return headers;
  }

  async function doFetch(
    request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);

    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    const headers = baseHeaders(request.headers);
    let body: BodyInit | undefined;

    if ("json" in request && request.json !== undefined) {
      body = JSON.stringify(request.json);
    } else if (request.body !== undefined) {
      body = request.body;
    }

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body,
        signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    fetchJson: (request) => doFetch(request),
    fetchBlob: (request) => doFetch(request),
  };
}
