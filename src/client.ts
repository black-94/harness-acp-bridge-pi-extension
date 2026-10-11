/**
 * HTTP client for the harness-acp-bridge server.
 *
 * The client owns no scheduling, ACP protocol, launch logic, or persistence: it is a thin
 * transport over `POST /api/<name>`. Success is `{ ok: true, data }`; failure is
 * `{ ok: false, error: { code, message, detail } }`. Success is never guessed.
 */
import { isRecord, type BridgeSettings } from "./config.ts";

export class BridgeError extends Error {
  override name = "BridgeError";
  constructor(public readonly code: string, message: string, public readonly detail?: unknown) {
    super(message);
  }
}

export function errorInfo(error: unknown): { code: string; message: string; detail?: unknown } {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) };
  }
  return { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}

export interface BridgeConnection {
  call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class BridgeHttpClient implements BridgeConnection {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(settings: BridgeSettings) {
    this.baseUrl = settings.baseUrl.replace(/\/$/, "");
    this.timeoutMs = settings.requestTimeoutMs;
  }

  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timedOut = { value: false };
    const timeoutController = new AbortController();
    const timer = setTimeout(() => { timedOut.value = true; timeoutController.abort(); }, this.timeoutMs);
    timer.unref?.();
    const composite = signal ? AbortSignal.any([timeoutController.signal, signal]) : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args ?? {}),
        signal: composite,
      });
    } catch (error) {
      if (signal?.aborted) throw new BridgeError("request_aborted", "the HTTP request was cancelled");
      if (timedOut.value) throw new BridgeError("request_timeout", `${name} did not answer within ${this.timeoutMs}ms`);
      throw new BridgeError("network_error", `could not reach harness-acp-bridge at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try { text = await response.text(); }
    catch (error) {
      if (signal?.aborted) throw new BridgeError("request_aborted", "the HTTP response was cancelled");
      throw new BridgeError("invalid_response", `${name} response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new BridgeError("invalid_response", `${name} returned a non-JSON response (HTTP ${response.status})`); }
    if (!isRecord(body)) throw new BridgeError("invalid_response", `${name} returned a non-object envelope (HTTP ${response.status})`);

    if (body.ok === true) {
      if (!isRecord(body.data)) throw new BridgeError("invalid_response", `${name} succeeded without an object "data"`);
      return body.data;
    }
    if (body.ok === false && isRecord(body.error)) {
      const error = body.error;
      const code = typeof error.code === "string" && error.code ? error.code : "server_error";
      const message = typeof error.message === "string" && error.message ? error.message : `${name} failed`;
      throw new BridgeError(code, message, error.detail);
    }
    throw new BridgeError("invalid_response", `${name} returned an unrecognized envelope (HTTP ${response.status})`);
  }
}
