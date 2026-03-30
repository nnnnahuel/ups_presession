const BASE_URL = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const MAX_RETRIES = 3;

export class SpotifyClient {
  constructor({ clientId, clientSecret, refreshToken }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = null;
  }

  async authenticate() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
      },
      body,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Spotify auth failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;

    return {
      accessToken: data.access_token,
      newRefreshToken: data.refresh_token || null,
    };
  }

  async getPlaylistItems(playlistId) {
    const items = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await this.#get(`/playlists/${playlistId}/items`, {
        limit,
        offset,
        fields: "items(added_at,track(uri,id,name,explicit,artists(name,id))),total",
      });

      if (!data.items?.length) {
        break;
      }

      items.push(...data.items.filter((item) => item.track));

      offset += limit;
      if (offset >= (data.total || items.length)) {
        break;
      }
    }

    return items;
  }

  async addToPlaylist(playlistId, uris) {
    const validUris = sanitizeUris(uris);

    if (!validUris.length) {
      return;
    }

    for (let index = 0; index < validUris.length; index += 100) {
      const batch = validUris.slice(index, index + 100);
      await this.#post(`/playlists/${playlistId}/items`, { uris: batch });
    }
  }

  async removeFromPlaylist(playlistId, uris) {
    const validUris = sanitizeUris(uris);

    if (!validUris.length) {
      return;
    }

    for (let index = 0; index < validUris.length; index += 100) {
      const batch = validUris.slice(index, index + 100);
      await this.#delete(`/playlists/${playlistId}/items`, {
        items: batch.map((uri) => ({ uri })),
      });
    }
  }

  async searchTracks(query, limit = 10, pages = 1) {
    const tracks = [];

    for (let page = 0; page < pages; page += 1) {
      try {
        const data = await this.#get("/search", {
          q: query,
          type: "track",
          limit: Math.min(limit, 10),
          offset: page * 10,
        });

        if (data.tracks?.items) {
          tracks.push(...data.tracks.items);
        }
      } catch (error) {
        console.warn(`[playlist] Spotify search failed for "${query}": ${error.message}`);
        break;
      }
    }

    return tracks;
  }

  async getMyTopTracks(timeRange = "medium_term", limit = 50) {
    const data = await this.#get("/me/top/tracks", {
      time_range: timeRange,
      limit: Math.min(limit, 50),
    });

    return data.items || [];
  }

  async #get(path, params = {}) {
    const search = new URLSearchParams(params).toString();
    return this.#request(`${BASE_URL}${path}${search ? `?${search}` : ""}`);
  }

  async #post(path, body = {}) {
    return this.#request(`${BASE_URL}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async #delete(path, body = {}) {
    return this.#request(`${BASE_URL}${path}`, {
      method: "DELETE",
      body: JSON.stringify(body),
    });
  }

  async #request(url, options = {}, retries = 0) {
    if (!this.accessToken) {
      throw new Error("Spotify client is not authenticated.");
    }

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.status === 429 && retries < MAX_RETRIES) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "1", 10);
      const waitMs = retryAfter * 1000 * Math.pow(2, retries);
      await sleep(waitMs);
      return this.#request(url, options, retries + 1);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Spotify API error ${response.status} on ${url}: ${detail}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeUris(uris) {
  return [...new Set((Array.isArray(uris) ? uris : []).filter(isSpotifyTrackUri))];
}

function isSpotifyTrackUri(value) {
  return typeof value === "string" && /^spotify:track:[A-Za-z0-9]+$/.test(value);
}
