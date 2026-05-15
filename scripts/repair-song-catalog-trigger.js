#!/usr/bin/env node
import { getDb } from '../src/shared/db.js';
import { ensureSongCatalogCleanupSchema } from '../src/shared/song-catalog-cleanup.js';

const db = getDb();
ensureSongCatalogCleanupSchema(db);
console.log('[song-catalog] trigger/schema guard repaired');
