import { selectTracksForRemoval } from "./selector.mjs";
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
    const pausadasItems = await spotify.getPlaylistItems(config.PAUSADAS_PLAYLIST_ID);

    result.details.playlistSizeBefore = playlistItems.length;
    result.details.archiveSizeBefore = archiveItems.length;
    result.details.pausadasSizeBefore = pausadasItems.length;

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
    const excludeTrackKeys = new Set([
      ...playlistItems.map((item) => buildTrackKey(item.track.name, item.track.artists[0]?.name)),
      ...archiveItems.map((item) => buildTrackKey(item.track.name, item.track.artists[0]?.name)),
    ]);

    await purgeOldHistory(pool, config.COOLDOWN_DAYS);
    const cooldownUris = await getCooldownUris(pool, config.COOLDOWN_DAYS);
    const excludeUris = new Set([...currentUris, ...archiveUris, ...cooldownUris]);

    const targetAddCount = selection.toRemove.length || config.ROTATION_COUNT;

    // Pick from "pausadas": oldest first, skip already-present or cooldown tracks
    const pausadasCandidates = pausadasItems
      .filter((item) => {
        if (!item.track) return false;
        if (excludeUris.has(item.track.uri)) return false;
        const key = buildTrackKey(item.track.name, item.track.artists[0]?.name);
        if (excludeTrackKeys.has(key)) return false;
        return true;
      })
      .sort((a, b) => new Date(a.added_at) - new Date(b.added_at))
      .slice(0, targetAddCount);

    result.details.removedCandidates = selection.toRemove.map(formatPlaylistItem);
    result.details.addedCandidates = pausadasCandidates.map(formatPlaylistItem);
    result.details.cooldownCount = cooldownUris.size;
    result.details.replacementCount = pausadasCandidates.length;

    if (pausadasCandidates.length < targetAddCount) {
      logger.warn(
        `[playlist] pausadas only has ${pausadasCandidates.length} eligible tracks, wanted ${targetAddCount}`
      );
    }

    if (!dryRun) {
      if (selection.toRemove.length) {
        const removedUris = selection.toRemove.map((item) => item.track.uri);
        const archiveInsertUris = removedUris.filter((uri) => !archiveUris.has(uri));

        result.details.archiveInsertCount = archiveInsertUris.length;

        if (archiveInsertUris.length) {
          await spotify.addToPlaylist(config.ARCHIVE_PLAYLIST_ID, archiveInsertUris);
        }

        await spotify.removeFromPlaylist(config.MAIN_PLAYLIST_ID, removedUris);
        await recordRemovedTracks(pool, selection.toRemove);
        result.removed = removedUris.length;
      }

      if (pausadasCandidates.length) {
        const urisToAdd = pausadasCandidates.map((item) => item.track.uri);

        await spotify.addToPlaylist(config.MAIN_PLAYLIST_ID, urisToAdd);
        await spotify.removeFromPlaylist(config.PAUSADAS_PLAYLIST_ID, urisToAdd);
        result.added = urisToAdd.length;
      }
    } else {
      result.removed = selection.toRemove.length;
      result.added = pausadasCandidates.length;
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
    "SPOTIFY_MAIN_PLAYLIST_ID",
    "SPOTIFY_ARCHIVE_PLAYLIST_ID",
    "SPOTIFY_PAUSADAS_PLAYLIST_ID",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    MAIN_PLAYLIST_ID: process.env.SPOTIFY_MAIN_PLAYLIST_ID,
    ARCHIVE_PLAYLIST_ID: process.env.SPOTIFY_ARCHIVE_PLAYLIST_ID,
    PAUSADAS_PLAYLIST_ID: process.env.SPOTIFY_PAUSADAS_PLAYLIST_ID,
    ROTATION_COUNT: parseInteger(process.env.PLAYLIST_ROTATION_COUNT, 5),
    MIN_PLAYLIST_SIZE: parseInteger(process.env.PLAYLIST_MIN_PLAYLIST_SIZE, 40),
    COOLDOWN_DAYS: parseInteger(process.env.PLAYLIST_COOLDOWN_DAYS, 45),
  };
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPlaylistItem(item) {
  return {
    uri: item.track.uri,
    name: item.track.name,
    artist: item.track.artists[0]?.name || "Unknown",
    addedAt: item.added_at,
  };
}

function buildTrackKey(name, artist) {
  return `${normalizeArtist(artist)}::${normalizeTrackName(name)}`;
}

function normalizeArtist(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTrackName(value) {
  let normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  normalized = normalized.replace(/\[[^\]]*\]/g, " ");
  normalized = normalized.replace(/\(([^)]*)\)/g, (match, inner) => {
    return /\b(remix|mix|edit|version|live|extended|club|dub|remaster|acoustic|instrumental|vip)\b/i.test(
      inner
    )
      ? " "
      : match;
  });
  normalized = normalized.replace(/\s+-\s+(radio edit|remix|mix|edit|version|live|extended.*|club.*|dub.*|remaster.*)$/i, " ");
  normalized = normalized.replace(/[^a-z0-9]+/g, " ");

  return normalized.trim();
}
