const BASE_URL = "https://ws.audioscrobbler.com/2.0/";
const RATE_LIMIT_MS = 220;

let lastRequestAt = 0;

export class LastFmClient {
  constructor({ apiKey }) {
    this.apiKey = apiKey;
  }

  async getSimilarTracks(artist, track, limit = 15) {
    try {
      const data = await this.#request({
        method: "track.getSimilar",
        artist,
        track,
        limit: String(limit),
      });

      const tracks = data.similartracks?.track;
      if (!Array.isArray(tracks)) {
        return [];
      }

      return tracks.map((item) => ({
        name: item.name,
        artist: item.artist?.name || "",
        match: Number.parseFloat(item.match) || 0,
      }));
    } catch (error) {
      console.warn(
        `[playlist] Last.fm track.getSimilar failed for "${artist} - ${track}": ${error.message}`
      );
      return [];
    }
  }

  async getSimilarArtists(artist, limit = 10) {
    try {
      const data = await this.#request({
        method: "artist.getSimilar",
        artist,
        limit: String(limit),
      });

      const artists = data.similarartists?.artist;
      if (!Array.isArray(artists)) {
        return [];
      }

      return artists.map((item) => ({
        name: item.name,
        match: Number.parseFloat(item.match) || 0,
      }));
    } catch (error) {
      console.warn(`[playlist] Last.fm artist.getSimilar failed for "${artist}": ${error.message}`);
      return [];
    }
  }

  async #request(params) {
    await throttle();

    const search = new URLSearchParams({
      ...params,
      api_key: this.apiKey,
      format: "json",
    });

    const response = await fetch(`${BASE_URL}?${search.toString()}`);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Last.fm API error (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`Last.fm error ${data.error}: ${data.message}`);
    }

    return data;
  }
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;

  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  lastRequestAt = Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
