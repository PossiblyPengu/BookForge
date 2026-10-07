/**
 * /api/bookmaster/<path> — generic bridge to BookMaster.
 *
 * Pages Function: the PAGETURNER_SECRET bridge credential lives only in this
 * deployment's environment — client JS never sees it. Proxies verbatim to
 * BookMaster's /api/pageturner/<path> so status and body reach the page
 * unchanged. The whitelist names the routes the bridge may reach — a new
 * BookMaster endpoint joins it deliberately, not by URL shape.
 */

const BM = (env) => env.BOOKMASTER_URL || "https://bookmaster.pages.dev";

// Routes the bridge will carry. GET routes take their params in the query
// string; everything else is a POST body forwarded untouched.
const ROUTES = new Set([
  "link",
  "progress",
  "session",
  "quote",
  "comment",
  "comments",
  "library",
  "overview",
  "search",
  "together",
  "nudge",
  "nudge-answer",
  "book",
  "presence",
  "push-key",
  "push-subscribe",
  "push-unsubscribe",
  "push-inbox",
]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const onRequest = async ({ request, env, params }) => {
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  if (!ROUTES.has(path)) return json(404, { error: "Unknown bridge route" });
  if (!env.PAGETURNER_SECRET)
    return json(503, { error: "BookMaster sync isn't configured on this deployment" });

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST")
    return json(405, { error: "Method not allowed" });
  const isGet = method === "GET";

  // A few bridge names hide a different upstream path: redeeming a link code
  // lives at pageturner/redeem, and the push helpers are BookMaster's
  // endpoint-keyed routes, not pageturner ones. Everything else maps
  // straight into the bridge namespace.
  const upstreamPath = {
    link: "pageturner/redeem",
    "push-key": "push/key",
  }[path] || `pageturner/${path}`;

  const url = new URL(`${BM(env)}/api/${upstreamPath}`);
  if (isGet) new URL(request.url).searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const upstream = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${env.PAGETURNER_SECRET}`,
      ...(isGet ? {} : { "content-type": "application/json" }),
    },
    body: isGet ? undefined : await request.text(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
};
