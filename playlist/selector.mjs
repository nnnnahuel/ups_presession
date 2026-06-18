export function selectTracksForRemoval(
  playlistItems,
  rotationCount,
  minPlaylistSize,
  { replacementCount = 0 } = {}
) {
  const total = playlistItems.length;
  const safeReplacementCount = Math.max(0, Number(replacementCount) || 0);

  if (total <= minPlaylistSize && safeReplacementCount <= 0) {
    return {
      toRemove: [],
      skipped: true,
      reason: `Playlist has ${total} tracks, below minimum of ${minPlaylistSize}.`,
    };
  }

  const maxRemovable = total - minPlaylistSize + safeReplacementCount;
  const count = Math.min(rotationCount, maxRemovable);

  if (count <= 0) {
    return {
      toRemove: [],
      skipped: true,
      reason: `Cannot remove any tracks without going below minimum size ${minPlaylistSize}.`,
    };
  }

  const sorted = [...playlistItems].sort(
    (left, right) => new Date(left.added_at).getTime() - new Date(right.added_at).getTime()
  );

  return {
    toRemove: sorted.slice(0, count),
    skipped: false,
    reason:
      count < rotationCount
        ? `Requested ${rotationCount} removals but limited to ${count} by minimum size and replacements.`
        : null,
  };
}

export function extractSeedData(items) {
  return {
    tracks: items.map((item) => ({
      name: item.track.name,
      artist: item.track.artists[0]?.name || "Unknown",
      uri: item.track.uri,
    })),
    artistNames: [
      ...new Set(items.flatMap((item) => item.track.artists.map((artist) => artist.name))),
    ],
  };
}
