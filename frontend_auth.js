// frontend_auth.js -- runs on the GitHub Pages site.
//
// Handles the Plex PIN login (done entirely client-side, no server relay
// needed for the OAuth handshake itself), exchanges the resulting Plex
// token for a Supabase session via the plex-login Edge Function, then looks
// up which backend URL belongs to this account. No Plex data passes
// through Supabase at any point -- only identity and a URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://vgtfwnujsixuewhuwmue.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZndGZ3bnVqc2l4dWV3aHV3bXVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MDA4MjksImV4cCI6MjEwMzE3NjgyOX0.0aZiM3c_rj5NX2VtRMWPfYjJzOZC0FFDzGSZgwH2a3E";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CLIENT_ID_KEY = "plexlytics_client_id";
const BACKEND_URL_KEY = "plexlytics_backend_url";

function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

async function startPlexLogin() {
  const clientId = getClientId();

  const pinRes = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-Plex-Product": "Plexlytics",
      "X-Plex-Client-Identifier": clientId,
    },
  });
  const pin = await pinRes.json();

  const authUrl = new URL("https://app.plex.tv/auth#");
  authUrl.searchParams.set("clientID", clientId);
  authUrl.searchParams.set("code", pin.code);
  authUrl.searchParams.set("context[device][product]", "Plexlytics");
  window.open(authUrl.toString(), "_blank");

  return pollForToken(pin.id, clientId);
}

function pollForToken(pinId, clientId) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
        headers: {
          Accept: "application/json",
          "X-Plex-Client-Identifier": clientId,
        },
      });
      const data = await res.json();

      if (data.authToken) {
        clearInterval(interval);
        resolve(data.authToken);
      } else if (++attempts > 60) {
        // ~5 minutes at 5s intervals
        clearInterval(interval);
        reject(new Error("Login timed out -- please try again"));
      }
    }, 5000);
  });
}

async function loginWithPlex() {
  const plexToken = await startPlexLogin();

  const bridgeRes = await fetch(`${SUPABASE_URL}/functions/v1/plex-login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ plexToken }),
  });
  const { access_token, refresh_token, error } = await bridgeRes.json();
  if (error) throw new Error(error);

  await supabase.auth.setSession({ access_token, refresh_token });

  const { data: server } = await supabase
    .from("servers")
    .select("backend_url")
    .maybeSingle();

  if (!server) {
    // First-time login with no backend linked yet -- this account needs to
    // run the local setup wizard first (see the local dashboard's linking
    // step) before it has anywhere for this page to point to.
    return { linked: false };
  }

  localStorage.setItem(BACKEND_URL_KEY, server.backend_url);
  return { linked: true, backendUrl: server.backend_url };
}

async function callBackend(path, options = {}) {
  const backendUrl = localStorage.getItem(BACKEND_URL_KEY);
  if (!backendUrl) throw new Error("no backend linked yet");

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("not logged in");

  return fetch(`${backendUrl}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
}

export { loginWithPlex, callBackend };
