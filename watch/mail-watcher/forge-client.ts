// The forge REST client (one GET per read; the stateless adapter
// surface the source and the projection read through).

const API_TIMEOUT_MS = 15_000;

// The REST client: one GET per read against the forge's /api/v1, the
// adapter's credential in the header. The client is stateless — no
// session, no handshake, nothing to clean up — and its errors name the
// route and the status, never the url's tail beyond the route and never
// the token. A 404 marks its error, because "the forge has no such row"
// is a word the sweep acts on, unlike any other failure.
function forgeClient(forge) {
  const base = `${forge.url}/api/v1`;
  const routeOf = (path, params) => {
    const route = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) route.searchParams.set(key, String(value));
    }
    return route;
  };

  const request = async (path, params, expect) => {
    let response;
    try {
      response = await fetch(routeOf(path, params), {
        headers: {
          Accept: "application/json",
          Authorization: `token ${forge.token}`,
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GET ${path} → ${error?.message ?? error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      if (response.status === 404) {
        const gone = new Error(
          `GET ${path} → HTTP 404 ${response.statusText || "not found"}`,
        );
        gone.status = 404;
        throw gone;
      }
      throw new Error(
        `GET ${path} → HTTP ${response.status} ${response.statusText || "request failed"}`,
      );
    }
    if (expect === "text") return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GET ${path} → an unparseable JSON answer`);
    }
  };

  return {
    get: (path, params) => request(path, params),
    // The job-log read: the route serves plaintext (a JSON {content}
    // wrapper accepted), and the reader tails the lines it keeps.
    getLog: async (path, params) => {
      const text = await request(path, params, "text");
      if (text.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed?.content === "string") return parsed.content;
        } catch {
          // The plaintext log itself starting with "{" is the log.
        }
      }
      return text;
    },
  };
}

export { forgeClient };
