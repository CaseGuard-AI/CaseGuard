// Client for services/ai (/ai/v1). Every call carries the service token (ADR-0002, SEC-14).
export interface AiClient {
  info(): Promise<{ service: string; version: string }>;
}

export function createAiClient(baseUrl: string, token: string, timeoutMs = 3000): AiClient {
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`AI service ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
  return { info: () => get("/ai/v1/info") };
}
