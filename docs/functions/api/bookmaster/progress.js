/**
 * POST /api/bookmaster/progress — push a reading-progress update to BookMaster.
 *
 * Pages Function: the PAGETURNER_SECRET bridge credential lives only in this
 * deployment's environment — client JS never sees it. Proxies verbatim to
 * BookMaster so status and body reach the page unchanged.
 */

const BM = (env) => env.BOOKMASTER_URL || "https://bookmaster.pages.dev";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const onRequest = async ({ request, env }) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!env.PAGETURNER_SECRET)
    return json(503, { error: "BookMaster sync isn't configured on this deployment" });
  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Bad JSON" }); }
  const upstream = await fetch(`${BM(env)}/api/pageturner/progress`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PAGETURNER_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
};
