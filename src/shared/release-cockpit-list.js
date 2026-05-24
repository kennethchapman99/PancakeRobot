import {
  getAllAlbums,
  getAllSongs,
  getReleaseLinks,
  getSongsForAlbum,
} from './db.js';

export function listLightweightReleaseCockpitEntries() {
  const albums = getAllAlbums().map(album => {
    const tracks = getSongsForAlbum(album.id);
    const hyperfollowUrl = findPersistedHyperFollowUrl(tracks);
    return {
      type: 'album',
      id: album.id,
      title: album.album_title || album.album_theme || album.id,
      subtitle: 'Album release',
      lifecycle: hyperfollowUrl ? 'hyperfollow_ready' : (album.status || 'draft'),
      releaseDate: album.release_date || null,
      stageSummary: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
      blockerCount: 0,
      trackCount: tracks.length,
      brandProfileId: album.brand_profile_id || null,
      hyperfollowUrl,
      distributionStatus: summarizePersistedDistributionStatus(tracks),
      updatedAt: album.updated_at || album.created_at,
    };
  });

  const singles = getAllSongs()
    .filter(song => !song.album_id)
    .map(song => {
      const hyperfollowUrl = findPersistedHyperFollowUrl([song]);
      return {
        type: 'single',
        id: song.id,
        title: song.title || song.topic || song.id,
        subtitle: 'Single release',
        lifecycle: hyperfollowUrl ? 'hyperfollow_ready' : (song.status || 'draft'),
        releaseDate: song.release_date || null,
        stageSummary: '1 track',
        blockerCount: 0,
        trackCount: 1,
        brandProfileId: song.brand_profile_id || null,
        hyperfollowUrl,
        distributionStatus: song.distribution_status || song.status || null,
        updatedAt: song.updated_at || song.created_at,
      };
    });

  return [...albums, ...singles]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findPersistedHyperFollowUrl(tracks = []) {
  for (const track of tracks) {
    const smartLink = track?.marketing_links?.smart_link;
    if (smartLink && /hyperfollow|distrokid/i.test(smartLink)) return smartLink;
    for (const link of getReleaseLinks(track.id)) {
      if (link?.url && /hyperfollow|distrokid/i.test(`${link.platform || ''} ${link.url || ''}`)) {
        return link.url;
      }
    }
  }
  return '';
}

function summarizePersistedDistributionStatus(tracks = []) {
  const statuses = [...new Set(
    tracks
      .map(track => track.distribution_status || track.status)
      .filter(Boolean)
  )];
  if (!statuses.length) return null;
  if (statuses.length === 1) return statuses[0];
  return `${statuses.length} statuses`;
}
