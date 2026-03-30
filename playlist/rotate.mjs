import { LastFmClient } from "./lastfm.mjs";
import { findReplacements } from "./recommender.mjs";
import { extractSeedData, selectTracksForRemoval } from "./selector.mjs";
import { SpotifyClient } from "./spotify.mjs";
import {
  getCooldownUris,
  logExecution,
  purgeOldHistory,
  recordRemovedTracks,
} from "./state.mjs";

const ROTATION_LOCK_ID = 3202650;

export async function runPlaylistRotation({ pool, dryRun = false, logger = console } = {}) {
  if (!pool) {
    throw new Error("DATABASE_URL is required for playlist rotation.");
  }

  const config = readPlaylistConfig();
  const spotify = new SpotifyClient({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
  });
  const lastfm = new LastFmClient({
    apiKey: process.env.LASTFM_API_KEY,
  });

  const result = {
    removed: 0,
    added: 0,
    fallbackUsed: false,
    skipped: false,
    status: "success",
    errors: [],
    details: {
      dryRun,
      config: {
        rotationCount: config.ROTATION_COUNT,
        minPlaylistSize: config.MIN_PLAYLIST_SIZE,
        cooldownDays: config.COOLDOWN_DAYS,
      },
    },
  };

  const lockClient = await pool.connect();

  try {
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ROTATION_LOCK_ID]
    );

    if (!lockResult.rows[0]?.locked) {
      result.skipped = true;
      result.status = "skipped";
      result.errors.push("rotation_already_running");
      await logExecution(pool, result);
      return result;
    }

    logger.log(`[playlist] Rotation started (${dryRun ? "dry-run" : "live"})`);

    const auth = await spotify.authenticate();
    if (auth.newRefreshToken) {
      logger.warn("[playlist] Spotify returned a new refresh token. Update Railway env vars.");
    }

    const playlistItems = await spotify.getPlaylistItems(config.MAIN_PLAYLIST_ID);
    const archiveItems = await spotify.getPlaylistItems(config.ARCHIVE_PLAYLIST_ID);

    result.details.playlistSizeBefore = playlistItems.length;
    result.details.archiveSizeBefore = archiveItems.length;

    const selection = selectTracksForRemoval(
      playlistItems,
      config.ROTATION_COUNT,
      config.MIN_PLAYLIST_SIZE
    );

    if (selection.reason) {
      result.details.selectionReason = selection.reason;
    }

    if (selection.skipped) {
      result.skipped = true;
      result.status = "skipped";
    }

    const currentUris = new Set(playlistItems.map((item) => item.track.uri));
    const archiveUris = new Set(archiveItems.map((item) => item.track.uri));

    await purgeOldHistory(pool, config.COOLDOWN_DAYS);
    const cooldownUris = await getCooldownUris(pool, config.COOLDOWN_DAYS);
    const excludeUris = new Set([...currentUris, ...archiveUris, ...cooldownUris]);

    const seedSource =
      selection.toRemove.length > 0
        ? selection.toRemove
        : playlistItems
            .slice()
            .sort((left, right) => {
              return new Date(left.added_at).getTime() - new Date(right.added_at).getTime();
            })
            .slice(0, Math.min(config.ROTATION_COUNT, playlistItems.length));

    const { tracks: seedTracks, artistNames: seedArtists } = extractSeedData(seedSource);
    const targetAddCount = selection.toRemove.length || config.ROTATION_COUNT;

    const replacementResult = await findReplacements({
      spotify,
      lastfm,
      seedTracks,
      seedArtists,
      excludeUris,
      count: targetAddCount,
      config,
    });

    result.fallbackUsed = replacementResult.fallbackUsed;
    result.details.removedCandidates = selection.toRemove.map(formatPlaylistItem);
    result.details.addedCandidates = replacementResult.tracks.map(formatTrack);
    result.details.cooldownCount = cooldownUris.size;
    result.details.replacementCount = replacementResult.tracks.length;

    if (!dryRun) {
      if (selection.toRemove.length) {
        const removedUris = selection.toRemove.map((item) => item.track.uri);
        await spotify.addToPlaylist(config.ARCHIVE_PLAYLIST_ID, removedUris);
        await spotify.removeFromPlaylist(config.MAIN_PLAYLIST_ID, removedUris);
        await recordRemovedTracks(pool, selection.toRemove);
        result.removed = removedUris.length;
      }

      if (replacementResult.tracks.length) {
        await spotify.addToPlaylist(
          config.MAIN_PLAYLIST_ID,
          replacementResult.tracks.map((track) => track.uri)
        );
        result.added = replacementResult.tracks.length;
      }
    } else {
      result.removed = selection.toRemove.length;
      result.added = replacementResult.tracks.length;
    }

    result.details.playlistSizeAfterEstimate =
      playlistItems.length - result.removed + result.added;

    await logExecution(pool, result);
    return result;
  } catch (error) {
    result.status = "error";
    result.errors.push(error.message);
    result.details.stack = error.stack;
    await logExecution(pool, result);
    throw error;
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [ROTATION_LOCK_ID]);
    } catch {
      // Ignore unlock errors on teardown.
    }
    lockClient.release();
  }
}

export function readPlaylistConfig() {
  const required = [
    "SPOTIFY_CLIENT_ID",
    "SPOTIFY_CLIENT_SECRET",
    "SPOTIFY_REFRESH_TOKEN",
    "LASTFM_API_KEY",
    "SPOTIFY_MAIN_PLAYLIST_ID",
    "SPOTIFY_ARCHIVE_PLAYLIST_ID",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    MAIN_PLAYLIST_ID: process.env.SPOTIFY_MAIN_PLAYLIST_ID,
    ARCHIVE_PLAYLIST_ID: process.env.SPOTIFY_ARCHIVE_PLAYLIST_ID,
    ROTATION_COUNT: parseInteger(process.env.PLAYLIST_ROTATION_COUNT, 10),
    MIN_PLAYLIST_SIZE: parseInteger(process.env.PLAYLIST_MIN_PLAYLIST_SIZE, 40),
    COOLDOWN_DAYS: parseInteger(process.env.PLAYLIST_COOLDOWN_DAYS, 45),
    EXPLICIT_PENALTY: parseFloatValue(process.env.PLAYLIST_EXPLICIT_PENALTY, 0.3),
    TRACK_SIMILAR_BONUS: parseFloatValue(process.env.PLAYLIST_TRACK_SIMILAR_BONUS, 1.2),
    LASTFM_SIMILAR_TRACKS_LIMIT: parseInteger(
      process.env.PLAYLIST_LASTFM_SIMILAR_TRACKS_LIMIT,
      15
    ),
    LASTFM_SIMILAR_ARTISTS_LIMIT: parseInteger(
      process.env.PLAYLIST_LASTFM_SIMILAR_ARTISTS_LIMIT,
      10
    ),
    SPOTIFY_SEARCH_LIMIT: parseInteger(process.env.PLAYLIST_SPOTIFY_SEARCH_LIMIT, 10),
  };
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatValue(value, fallback) {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPlaylistItem(item) {
  return {
    uri: item.track.uri,
    name: item.track.name,
    artist: item.track.artists[0]?.name || "Unknown",
    addedAt: item.added_at,
    explicit: Boolean(item.track.explicit),
  };
}

function formatTrack(track) {
  return {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    score: track.score,
    explicit: Boolean(track.explicit),
  };
}
