/**
 * Bound a download response at `maxBytes` for every consumer. A declared
 * `Content-Length` over the limit cancels the body and throws before any byte
 * is read; otherwise the body errors with the same message once the bytes
 * actually received pass the limit, which cancels the network stream. `noun`
 * names the payload in the error, so each client keeps its existing wording.
 */
export async function boundedResponse(
  resp: Response,
  maxBytes: number,
  noun: string
): Promise<Response> {
  const tooLarge = () =>
    new Error(`${noun} size limit exceeded: ${noun} is larger than ${maxBytes} bytes`);
  const declared = resp.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!resp.body) return resp;
  if (typeof resp.body.pipeThrough !== "function") {
    throw new Error("cannot enforce size limit: response body is not streamable");
  }
  let received = 0;
  const body = resp.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    })
  );
  return new Response(body, { status: resp.status, headers: resp.headers });
}
