import http from "node:http";
import crypto from "node:crypto";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:8888/callback";
const port = Number(new URL(redirectUri).port || 8888);

if (!clientId || !clientSecret) {
  console.error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const scope = [
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-top-read",
].join(" ");

const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("scope", scope);
authorizeUrl.searchParams.set("state", state);

console.log("Open this URL in your browser:");
console.log(authorizeUrl.toString());

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", redirectUri);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end(`Spotify authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code || returnedState !== state) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Invalid callback.");
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const data = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(JSON.stringify(data));
    }

    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Spotify auth complete. You can close this window.");

    console.log("\nRefresh token:");
    console.log(data.refresh_token || "<none returned>");

    server.close();
  } catch (tokenError) {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("Failed to exchange code for token.");
    console.error(tokenError);
    server.close();
    process.exit(1);
  }
});

server.listen(port, () => {
  console.log(`Waiting for callback on ${redirectUri}`);
});
