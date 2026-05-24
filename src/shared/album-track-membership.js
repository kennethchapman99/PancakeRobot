import {
  getAlbum,
  getDb,
  getSongsForAlbum,
  updateAlbum,
} from './db.js';

export function removeSongsFromAlbum(albumId, songIds) {
  const db = getDb();
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);

  const uniqueSongIds = [...new Set((songIds || [])
    .map(id => String(id || '').trim())
    .filter(Boolean))];

  if (!uniqueSongIds.length) throw new Error('At least one song is required.');

  const currentIds = new Set(getSongsForAlbum(albumId).map(song => song.id));
  const ids = uniqueSongIds.filter(id => currentIds.has(id));

  if (!ids.length) throw new Error('No selected songs are assigned to this album.');

  const now = new Date().toISOString();

  const detach = db.prepare(`
    UPDATE songs
    SET album_id = NULL,
        track_number = NULL,
        album_role = NULL,
        inherited_album_plan_version = NULL,
        updated_at = ?
    WHERE album_id = ? AND id = ?
  `);

  const reorder = db.prepare(`
    UPDATE songs
    SET track_number = ?, updated_at = ?
    WHERE album_id = ? AND id = ?
  `);

  const remainingStmt = db.prepare(`
    SELECT id
    FROM songs
    WHERE album_id = ?
    ORDER BY COALESCE(track_number, 999), created_at ASC
  `);

  const tx = db.transaction((idsToRemove) => {
    for (const songId of idsToRemove) detach.run(now, albumId, songId);

    const remaining = remainingStmt.all(albumId).map(row => row.id);
    remaining.forEach((songId, index) => reorder.run(index + 1, now, albumId, songId));
  });

  tx(ids);

  updateAlbum(albumId, { number_of_songs: getSongsForAlbum(albumId).length });
  return getSongsForAlbum(albumId);
}
