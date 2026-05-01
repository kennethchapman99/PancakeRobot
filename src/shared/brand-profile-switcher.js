import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.resolve(__dirname, '../../config');
export const DEFAULT_BRAND_PROFILE_PATH = path.resolve(CONFIG_DIR, 'brand-profile.json');
export const ACTIVE_BRAND_SELECTION_PATH = path.resolve(CONFIG_DIR, 'active-brand-profile.json');

export function listBrandProfiles({ includeDefaultProfile = true } = {}) {
  const files = walkJsonFiles(CONFIG_DIR)
    .filter(filePath => {
      const base = path.basename(filePath).toLowerCase();
      return base.endsWith('brand.json') || (includeDefaultProfile && base === 'brand-profile.json');
    })
    .map(filePath => readBrandProfileSummary(filePath));

  const active = resolveActiveBrandProfilePath();
  return files
    .map(file => ({ ...file, active: samePath(file.absolute_path, active.profilePath) }))
    .sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (b.active && !a.active) return 1;
      return a.relative_path.localeCompare(b.relative_path);
    });
}

export function resolveActiveBrandProfilePath() {
  if (process.env.BRAND_PROFILE_PATH) {
    return {
      source: 'env',
      profilePath: path.resolve(process.env.BRAND_PROFILE_PATH),
      relativePath: path.relative(CONFIG_DIR, path.resolve(process.env.BRAND_PROFILE_PATH)),
    };
  }

  const selection = readSelectionFile();
  if (selection?.active_profile_path) {
    const profilePath = resolveConfigChildPath(selection.active_profile_path);
    return {
      source: 'active_selection',
      profilePath,
      relativePath: path.relative(CONFIG_DIR, profilePath),
    };
  }

  return {
    source: 'default',
    profilePath: DEFAULT_BRAND_PROFILE_PATH,
    relativePath: path.relative(CONFIG_DIR, DEFAULT_BRAND_PROFILE_PATH),
  };
}

export function setActiveBrandProfile(relativePath) {
  if (!relativePath || !String(relativePath).trim()) {
    throw new Error('No brand profile selected.');
  }

  const profilePath = resolveConfigChildPath(relativePath);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Brand profile not found: ${relativePath}`);
  }

  const summary = readBrandProfileSummary(profilePath);
  if (!summary.valid) {
    throw new Error(`Selected brand profile is invalid JSON: ${summary.error}`);
  }

  fs.writeFileSync(ACTIVE_BRAND_SELECTION_PATH, JSON.stringify({
    active_profile_path: path.relative(CONFIG_DIR, profilePath),
    selected_at: new Date().toISOString(),
  }, null, 2));

  return summary;
}

function readSelectionFile() {
  if (!fs.existsSync(ACTIVE_BRAND_SELECTION_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_BRAND_SELECTION_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readBrandProfileSummary(filePath) {
  const relativePath = path.relative(CONFIG_DIR, filePath);
  try {
    const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      relative_path: relativePath,
      absolute_path: filePath,
      file_name: path.basename(filePath),
      valid: true,
      error: null,
      brand_name: profile.brand_name || profile.app_title || path.basename(filePath, '.json'),
      app_title: profile.app_title || profile.brand_name || '',
      brand_type: profile.brand_type || '',
      brand_description: profile.brand_description || '',
      default_artist: profile.distribution?.default_artist || '',
      primary_genre: profile.distribution?.primary_genre || '',
      audience: profile.audience?.description || profile.audience?.age_range || '',
      logo_path: profile.ui?.logo_path || '',
    };
  } catch (error) {
    return {
      relative_path: relativePath,
      absolute_path: filePath,
      file_name: path.basename(filePath),
      valid: false,
      error: error.message,
      brand_name: path.basename(filePath, '.json'),
      app_title: '',
      brand_type: '',
      brand_description: '',
      default_artist: '',
      primary_genre: '',
      audience: '',
      logo_path: '',
    };
  }
}

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJsonFiles(fullPath);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) return [fullPath];
    return [];
  });
}

function resolveConfigChildPath(relativePath) {
  const resolved = path.resolve(CONFIG_DIR, relativePath);
  const withSep = CONFIG_DIR.endsWith(path.sep) ? CONFIG_DIR : `${CONFIG_DIR}${path.sep}`;
  if (resolved !== CONFIG_DIR && !resolved.startsWith(withSep)) {
    throw new Error('Brand profile path must be inside config/.');
  }
  return resolved;
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}
