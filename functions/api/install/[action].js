/**
 * /api/install/<action> — the server half of the webpage install flow.
 *
 * Actions:
 *   GET  mobileconfig   → a "Profile Service" .mobileconfig; installing it
 *                         makes iOS POST this device's UDID to udid-callback
 *   POST udid-callback  ← iOS delivers the attributes plist; we 301 back to
 *                         /install.html with the UDID in the query
 *   POST dispatch       → repository_dispatch → the ota-sign workflow.
 *                         Gated by INSTALL_GATE; the PAT lives only in env.
 *   GET  status         → status-<rid>.json proxied from the ota-latest
 *                         release (rid in the URL is the bearer token)
 *   GET  manifest       → manifest-<rid>.plist, for the itms-services link
 *   GET  ipa            → Pageturner-<rid>.ipa, referenced by the manifest
 *
 * Env (Pages project settings → variables):
 *   GITHUB_DISPATCH_TOKEN  — PAT with `repo` scope, used for dispatches
 *   INSTALL_GATE           — passphrase the page must present (private use)
 *   OTA_REPO               — optional owner/name override (default below)
 */

const REPO = (env) => env.OTA_REPO || "PossiblyPengu/PageTurner";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const RID_RE = /^[a-zA-Z0-9-]{8,64}$/;

const gateOk = (env, request) => {
  if (!env.INSTALL_GATE) return false; // fail closed: owner must set it
  return new URL(request.url).searchParams.get("gate") === env.INSTALL_GATE;
};

async function releaseAssets(env) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO(env)}/releases/tags/ota-latest`,
    {
      headers: {
        "User-Agent": "pageturner-install",
        Accept: "application/vnd.github+json",
        ...(env.GITHUB_DISPATCH_TOKEN
          ? { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}` }
          : {}),
      },
    }
  );
  if (!r.ok) return null;
  return (await r.json()).assets || [];
}

async function asset(env, name, type) {
  const assets = await releaseAssets(env);
  const hit = (assets || []).find((a) => a.name === name);
  if (!hit) return null;
  const r = await fetch(hit.url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "pageturner-install",
      ...(env.GITHUB_DISPATCH_TOKEN
        ? { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}` }
        : {}),
    },
    redirect: "follow",
  });
  if (!r.ok) return null;
  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      ...(type === "application/octet-stream"
        ? { "content-disposition": `inline; filename="${name}"` }
        : {}),
    },
  });
}

// --- actions ---------------------------------------------------------------

const mobileconfig = (request) => {
  const origin = new URL(request.url).origin;
  const uuid = crypto.randomUUID();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key><string>${origin}/api/install/udid-callback</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string><string>PRODUCT</string><string>VERSION</string><string>SERIAL</string>
    </array>
  </dict>
  <key>PayloadDescription</key><string>Registers this iPhone for Pageturner installs</string>
  <key>PayloadDisplayName</key><string>Pageturner — device registration</string>
  <key>PayloadIdentifier</key><string>io.github.possiblypengu.pageturner.install</string>
  <key>PayloadOrganization</key><string>Pageturner</string>
  <key>PayloadType</key><string>Profile Service</string>
  <key>PayloadUUID</key><string>${uuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
  return new Response(plist, {
    headers: {
      "content-type": "application/x-apple-aspen-config",
      "content-disposition": 'attachment; filename="Pageturner.mobileconfig"',
      "cache-control": "no-store",
    },
  });
};

const udidCallback = async (request) => {
  const body = await request.text();
  const grab = (k) =>
    (body.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)<`)) || [])[1] || "";
  const udid = grab("UDID");
  const origin = new URL(request.url).origin;
  const q = new URLSearchParams({
    udid,
    device: grab("PRODUCT"),
    os: grab("VERSION"),
  });
  // iOS opens this in Safari right after the profile installs.
  return Response.redirect(`${origin}/install.html?${q}`, 301);
};

const dispatch = async (request, env) => {
  if (!env.GITHUB_DISPATCH_TOKEN)
    return json(503, { error: "GITHUB_DISPATCH_TOKEN isn't configured on this deployment" });
  if (!gateOk(env, request)) return json(403, { error: "Bad passphrase" });

  const p = await request.json().catch(() => ({}));
  const payload = {
    request_id: String(p.request_id || ""),
    udid: String(p.udid || ""),
    apple_id: String(p.apple_id || ""),
    password: String(p.password || ""),
    twofa: String(p.twofa || ""),
    device_name: String(p.device_name || "iPhone").slice(0, 60),
    nonce: String(p.nonce || "").slice(0, 64),
  };
  if (!RID_RE.test(payload.request_id))
    return json(400, { error: "bad request_id" });
  if (!/^[0-9a-fA-F]{24,40}$/.test(payload.udid))
    return json(400, { error: "bad udid" });
  if (!/^\S+@\S+$/.test(payload.apple_id) || !payload.password)
    return json(400, { error: "apple_id + password required" });
  if (payload.twofa && !/^\d{6}$/.test(payload.twofa))
    return json(400, { error: "twofa must be the 6-digit code" });

  const r = await fetch(`https://api.github.com/repos/${REPO(env)}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pageturner-install",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: "ota-sign", client_payload: payload }),
  });
  return r.ok || r.status === 204
    ? json(200, { ok: true })
    : json(502, { error: `GitHub dispatch failed (${r.status})` });
};

export const onRequest = async ({ request, env, params }) => {
  const action = Array.isArray(params.action)
    ? params.action.join("/")
    : params.action || "";

  if (action === "mobileconfig" && request.method === "GET")
    return mobileconfig(request);
  if (action === "udid-callback") return udidCallback(request);
  if (action === "dispatch" && request.method === "POST")
    return dispatch(request, env);
  const rid = new URL(request.url).searchParams.get("rid") || "";
  const ridOk = RID_RE.test(rid);
  if (action === "status" && request.method === "GET") {
    if (!gateOk(env, request)) return json(403, { error: "Bad passphrase" });
    const r = ridOk && (await asset(env, `status-${rid}.json`, "application/json"));
    return r || json(404, { state: "pending" });
  }
  if (action === "manifest" && request.method === "GET") {
    const r = ridOk && (await asset(env, `manifest-${rid}.plist`, "text/xml"));
    return r || new Response("not found", { status: 404 });
  }
  if (action === "ipa" && request.method === "GET") {
    const r = ridOk && (await asset(env, `Pageturner-${rid}.ipa`, "application/octet-stream"));
    return r || new Response("not found", { status: 404 });
  }
  return json(404, { error: "Unknown install route" });
};
