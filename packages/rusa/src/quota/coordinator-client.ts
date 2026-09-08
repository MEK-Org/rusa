import http from "node:http";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  type PublishedThrottleCollectionResponse,
  type PublishedThrottleResponse,
  validateProtocolMajor,
} from "./coordinator-protocol.js";

export interface QuotaCoordinatorClientOptions {
  socketPath: string;
  defaultIntervalSeconds?: number;
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export class QuotaCoordinatorClient {
  private lastAppliedIntervals: Map<string, number> = new Map();

  constructor(readonly options: QuotaCoordinatorClientOptions) {}

  getLastAppliedInterval(provider: string): number {
    return this.lastAppliedIntervals.get(provider) ?? this.options.defaultIntervalSeconds ?? 3600;
  }

  /**
   * Apply a response from the quota coordinator, strictly enforcing client-side
   * protocolMajor compatibility on every response per §5.2 and Criterion 9.
   */
  applyResponse(provider: string, body: unknown): boolean {
    try {
      validateProtocolMajor(body, COORDINATOR_PROTOCOL_MAJOR);
    } catch (err) {
      this.options.logger?.warn(
        `[quota-client] Discarding response for ${provider} due to protocol mismatch: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "intervalSeconds" in body &&
      typeof (body as { intervalSeconds: unknown }).intervalSeconds === "number"
    ) {
      this.lastAppliedIntervals.set(
        provider,
        (body as { intervalSeconds: number }).intervalSeconds
      );
      return true;
    }

    return true;
  }

  async getThrottle(
    provider?: string
  ): Promise<PublishedThrottleResponse | PublishedThrottleCollectionResponse | null> {
    const path = provider
      ? `/v1/throttle?provider=${encodeURIComponent(provider)}`
      : "/v1/throttle";

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed);
              } catch (err) {
                reject(err);
              }
            } else {
              resolve(null);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
}
