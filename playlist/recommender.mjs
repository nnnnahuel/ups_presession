export async function findReplacements({
  spotify,
  lastfm,
  seedTracks,
  seedArtists,
  excludeUris,
  count,
  config,
}) {
  const {
    EXPLICIT_PENALTY = 0.3,
    TRACK_SIMILAR_BONUS = 1.2,
    LASTFM_SIMILAR_TRACKS_LIMIT = 15,
    LASTFM_SIMILAR_ARTISTS_LIMIT = 10,
    SPOTIFY_SEARCH_LIMIT = 10,
  } = config;

  const candidates = await gatherLastFmCandidates({
    lastfm,
    seedTracks,
    seedArtists,
    tracksLimit: LASTFM_SIMILAR_TRACKS_LIMIT,
    artistsLimit: LASTFM_SIMILAR_ARTISTS_LIMIT,
  });

  const materialized = await materializeOnSpotify({
    spotify,
    candidates,
    searchLimit: SPOTIFY_SEARCH_LIMIT,
  });

  let scored = scoreAndFilter({
    tracks: materialized,
    excludeUris,
    explicitPenalty: EXPLICIT_PENALTY,
    trackSimilarBonus: TRACK_SIMILAR_BONUS,
  });

  let fallbackUsed = false;
  if (scored.length < count) {
    fallbackUsed = true;
    const fallbackTracks = await tryFallbacks({
      spotify,
      lastfm,
      candidates,
      excludeUris: new Set([...excludeUris, ...scored.map((track) => track.uri)]),
      needed: count - scored.length,
      explicitPenalty: EXPLICIT_PENALTY,
    });

    scored = [...scored, ...fallbackTracks];
  }

  return {
    tracks: scored.slice(0, count),
    fallbackUsed,
  };
}

async function gatherLastFmCandidates({
  lastfm,
  seedTracks,
  seedArtists,
  tracksLimit,
  artistsLimit,
}) {
  const candidates = [];

  for (const seedTrack of seedTracks) {
    const similarTracks = await lastfm.getSimilarTracks(
      seedTrack.artist,
      seedTrack.name,
      tracksLimit
    );

    for (const item of similarTracks) {
      candidates.push({
        trackName: item.name,
        artistName: item.artist,
        match: item.match,
        source: "track",
      });
    }
  }

  for (const seedArtist of seedArtists) {
    const similarArtists = await lastfm.getSimilarArtists(seedArtist, artistsLimit);

    for (const item of similarArtists) {
      candidates.push({
        trackName: null,
        artistName: item.name,
        match: item.match,
        source: "artist",
      });
    }
  }

  return deduplicateCandidates(candidates);
}

async function materializeOnSpotify({ spotify, candidates, searchLimit }) {
  const results = [];
  const seenQueries = new Set();

  for (const candidate of candidates) {
    const cacheKey = candidate.trackName
      ? `${candidate.artistName}::${candidate.trackName}`
      : `artist::${candidate.artistName}`;

    if (seenQueries.has(cacheKey)) {
      continue;
    }

    seenQueries.add(cacheKey);

    const query = candidate.trackName
      ? `track:${candidate.trackName} artist:${candidate.artistName}`
      : `artist:${candidate.artistName}`;

    const tracks = await spotify.searchTracks(query, searchLimit, 1);
    for (const track of tracks) {
      results.push({
        uri: track.uri,
        name: track.name,
        artist: track.artists?.[0]?.name || "Unknown",
        explicit: track.explicit || false,
        matchScore: candidate.match,
        candidateSource: candidate.source,
      });
    }
  }

  return results;
}

function scoreAndFilter({ tracks, excludeUris, explicitPenalty, trackSimilarBonus }) {
  const seenUris = new Set();
  const scored = [];

  for (const track of tracks) {
    if (excludeUris.has(track.uri) || seenUris.has(track.uri)) {
      continue;
    }

    seenUris.add(track.uri);

    const sourceBonus = track.candidateSource === "track" ? trackSimilarBonus : 1;
    const explicitMultiplier = track.explicit ? explicitPenalty : 1;
    const jitter = 0.9 + Math.random() * 0.2;

    scored.push({
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      explicit: track.explicit,
      score: track.matchScore * sourceBonus * explicitMultiplier * jitter,
    });
  }

  scored.sort((left, right) => right.score - left.score);
  return scored;
}

async function tryFallbacks({ spotify, lastfm, candidates, excludeUris, needed, explicitPenalty }) {
  const fallbackTracks = [];
  const topArtistCandidates = candidates
    .filter((candidate) => candidate.source === "artist")
    .sort((left, right) => right.match - left.match)
    .slice(0, 3);

  for (const candidate of topArtistCandidates) {
    if (fallbackTracks.length >= needed) {
      break;
    }

    const secondDegree = await lastfm.getSimilarArtists(candidate.artistName, 5);
    for (const similarArtist of secondDegree) {
      if (fallbackTracks.length >= needed) {
        break;
      }

      const tracks = await spotify.searchTracks(`artist:${similarArtist.name}`, 10, 1);
      for (const track of tracks) {
        if (excludeUris.has(track.uri) || fallbackTracks.some((item) => item.uri === track.uri)) {
          continue;
        }

        fallbackTracks.push({
          uri: track.uri,
          name: track.name,
          artist: track.artists?.[0]?.name || "Unknown",
          explicit: track.explicit || false,
          score: similarArtist.match * 0.8 * (track.explicit ? explicitPenalty : 1),
        });

        if (fallbackTracks.length >= needed) {
          break;
        }
      }
    }
  }

  if (fallbackTracks.length < needed) {
    try {
      const topTracks = await spotify.getMyTopTracks("medium_term", 50);
      for (const track of topTracks) {
        if (fallbackTracks.length >= needed) {
          break;
        }

        if (excludeUris.has(track.uri) || fallbackTracks.some((item) => item.uri === track.uri)) {
          continue;
        }

        fallbackTracks.push({
          uri: track.uri,
          name: track.name,
          artist: track.artists?.[0]?.name || "Unknown",
          explicit: track.explicit || false,
          score: 0.5 * (track.explicit ? explicitPenalty : 1),
        });
      }
    } catch (error) {
      console.warn(`[playlist] Top tracks fallback failed: ${error.message}`);
    }
  }

  return fallbackTracks;
}

function deduplicateCandidates(candidates) {
  const deduped = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.artistName.toLowerCase()}::${(candidate.trackName || "").toLowerCase()}`;
    const current = deduped.get(key);
    if (!current || candidate.match > current.match) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}
