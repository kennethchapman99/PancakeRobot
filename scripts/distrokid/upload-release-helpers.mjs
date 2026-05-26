import { join } from 'path';

import { writeJson } from './lib.mjs';

export const BLOCKED_UPLOAD_VALIDATION_CODE = 'blocked_upload_validation';
export const BLOCKED_UPLOAD_VALIDATION_EXIT_CODE = 22;
export const TRACK_COUNT_VALIDATION_ARTIFACT = 'track-count-validation.json';

export function getDistroKidTrackCountLabel(trackCount) {
  const count = Math.max(1, Number(trackCount) || 1);
  return count === 1 ? '1 song (a single)' : `${count} songs`;
}

export function isAlbumManifest(manifest) {
  return Array.isArray(manifest?.tracks) && manifest.tracks.length > 0;
}

export function isTrackLevelField(fieldName, fieldDef = {}) {
  const key = fieldDef.manifest_key || fieldName;
  return [
    'audio_file',
    'track_title',
    'lyrics_file',
    'explicit',
    'clean_always',
    'contains_lyrics',
    'instrumental',
    'songwriter_real_name.role',
    'songwriter_real_name.first',
    'songwriter_real_name.middle',
    'songwriter_real_name.last',
    'apple_music_credits.performer.role',
    'apple_music_credits.performer.name',
    'apple_music_credits.producer.role',
    'apple_music_credits.producer.name',
  ].includes(key);
}

export function fieldDefForTrack(fieldDef, trackNumber) {
  const replaceTrack = value => String(value)
    .replaceAll('{{track}}', String(trackNumber))
    .replaceAll('{{trackIndex}}', String(trackNumber))
    .replaceAll('Track 1', `Track ${trackNumber}`)
    .replaceAll('track-1-', `track-${trackNumber}-`)
    .replaceAll('title_1', `title_${trackNumber}`)
    .replaceAll('js-track-upload-1', `js-track-upload-${trackNumber}`)
    .replaceAll('radio-button-1', `radio-button-${trackNumber}`)
    .replaceAll('songwriter_real_name_first1', `songwriter_real_name_first${trackNumber}`)
    .replaceAll('songwriter_real_name_middle1', `songwriter_real_name_middle${trackNumber}`)
    .replaceAll('songwriter_real_name_last1', `songwriter_real_name_last${trackNumber}`);
  const next = { ...fieldDef, track_number: trackNumber };
  for (const key of ['selector', 'name_prefix', 'labelText', 'label_text']) {
    if (next[key]) next[key] = replaceTrack(next[key]);
  }
  return next;
}

export function createTrackCountValidationError(result = {}) {
  const requested = Number(result.requestedTrackCount || 0) || 0;
  const selected = result.selectedOption || 'unknown';
  const rendered = Number(result.renderedTrackCount || 0) || 0;
  const reason = result.error || 'DistroKid Number of songs validation failed.';
  return {
    field: 'number_of_songs',
    code: BLOCKED_UPLOAD_VALIDATION_CODE,
    error: `${reason} Requested ${requested} track${requested === 1 ? '' : 's'}, selected "${selected}", rendered ${rendered}.`,
    requested_track_count: requested,
    selected_option: selected,
    rendered_track_count: rendered,
  };
}

export function writeTrackCountValidationArtifact(artifactsDir, result, options = {}) {
  const payload = {
    ...result,
    requestedTrackCount: Number(result?.requestedTrackCount || 0) || 0,
    renderedTrackCount: Number(result?.renderedTrackCount || 0) || 0,
    saved_at: new Date().toISOString(),
  };
  (options.writeJsonImpl || writeJson)(join(artifactsDir, TRACK_COUNT_VALIDATION_ARTIFACT), payload);
  return payload;
}

export async function ensureDistroKidTrackCount(page, trackCount, artifactsDir, options = {}) {
  const requestedTrackCount = Math.max(1, Number(trackCount) || 1);
  const optionLabel = getDistroKidTrackCountLabel(requestedTrackCount);
  const locateAndSelect = options.locateAndSelectImpl || defaultLocateAndSelectTrackCount;
  const waitForRenderedTrackCount = options.waitForRenderedTrackCountImpl || defaultWaitForRenderedTrackCount;

  const selection = await locateAndSelect(page, requestedTrackCount, optionLabel);
  if (!selection?.ok) {
    const result = writeTrackCountValidationArtifact(artifactsDir, {
      requestedTrackCount,
      selectedOption: selection?.selectedOption || '',
      renderedTrackCount: Number(selection?.renderedTrackCount || 0) || 0,
      ok: false,
      error: selection?.error || `Number of songs dropdown does not contain required option: ${optionLabel}`,
      availableOptions: selection?.availableOptions || [],
    }, options);
    return result;
  }

  const renderedTrackCount = await waitForRenderedTrackCount(page, requestedTrackCount, options);
  const ok = renderedTrackCount >= requestedTrackCount;
  const result = writeTrackCountValidationArtifact(artifactsDir, {
    requestedTrackCount,
    selectedOption: selection.selectedOption || optionLabel,
    renderedTrackCount,
    ok,
    error: ok ? '' : `DistroKid rendered ${renderedTrackCount} track section${renderedTrackCount === 1 ? '' : 's'} after selecting "${selection.selectedOption || optionLabel}", expected at least ${requestedTrackCount}.`,
  }, options);
  return result;
}

export async function fillReleaseFields({
  page,
  manifest,
  fieldEntries,
  ensureTrackCount,
  runFieldForManifest,
}) {
  let trackCountEnsured = false;
  let trackCountResult = null;

  for (const [fieldName, fieldDef] of fieldEntries) {
    if (isAlbumManifest(manifest) && isTrackLevelField(fieldName, fieldDef)) {
      if (!trackCountEnsured) {
        trackCountResult = await ensureTrackCount(page, manifest.tracks.length);
        trackCountEnsured = true;
        if (!trackCountResult?.ok) {
          return {
            ok: false,
            code: BLOCKED_UPLOAD_VALIDATION_CODE,
            trackCountCheck: trackCountResult,
          };
        }
      }
      for (const [trackIndex, trackManifest] of manifest.tracks.entries()) {
        const trackFieldDef = fieldDefForTrack(fieldDef, trackIndex + 1);
        await runFieldForManifest(page, `${fieldName}_track_${trackIndex + 1}`, trackFieldDef, trackManifest);
      }
      continue;
    }
    await runFieldForManifest(page, fieldName, fieldDef, manifest);
  }

  return {
    ok: true,
    code: '',
    trackCountCheck: trackCountResult,
  };
}

async function defaultLocateAndSelectTrackCount(page, requestedTrackCount, optionLabel) {
  return page.evaluate(({ optionLabel, requestedTrackCount }) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textNearSelect = select => {
      const fragments = new Set();
      if (select.id) {
        document.querySelectorAll(`label[for="${CSS.escape(select.id)}"]`).forEach(label => fragments.add(label.innerText));
      }
      select.labels?.forEach?.(label => fragments.add(label.innerText));
      let cursor = select.parentElement;
      for (let depth = 0; cursor && depth < 4; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) fragments.add(cursor.innerText);
      }
      let sibling = select.previousElementSibling;
      for (let depth = 0; sibling && depth < 3; depth += 1, sibling = sibling.previousElementSibling) {
        if (sibling.innerText) fragments.add(sibling.innerText);
      }
      return [...fragments].map(normalize).join(' ');
    };

    const candidates = [...document.querySelectorAll('select')]
      .filter(visible)
      .map(select => {
        const options = [...select.options].map(option => ({
          text: String(option.text || '').trim(),
          value: option.value,
        }));
        const selectedOption = options.find(option => option.value === select.value)?.text || '';
        return {
          select,
          context: textNearSelect(select),
          options,
          selectedOption,
        };
      })
      .filter(candidate => candidate.context.includes('number of songs'));

    if (!candidates.length) {
      return {
        ok: false,
        error: 'Number of songs dropdown not found near label text "Number of songs".',
        selectedOption: '',
        availableOptions: [],
        renderedTrackCount: 0,
      };
    }

    const candidate = candidates.find(item => item.options.some(option => normalize(option.text) === normalize(optionLabel))) || candidates[0];
    const match = candidate.options.find(option => normalize(option.text) === normalize(optionLabel));
    if (!match) {
      return {
        ok: false,
        error: `Number of songs dropdown does not contain required option: ${optionLabel}`,
        selectedOption: candidate.selectedOption || '',
        availableOptions: candidate.options.map(option => option.text),
        renderedTrackCount: countRenderedTrackBlocks(),
      };
    }

    candidate.select.value = match.value;
    candidate.select.dispatchEvent(new Event('input', { bubbles: true }));
    candidate.select.dispatchEvent(new Event('change', { bubbles: true }));
    candidate.select.dispatchEvent(new Event('blur', { bubbles: true }));
    return {
      ok: true,
      selectedOption: match.text,
      availableOptions: candidate.options.map(option => option.text),
      renderedTrackCount: countRenderedTrackBlocks(),
      requestedTrackCount,
    };
  }, { optionLabel, requestedTrackCount });
}

async function defaultWaitForRenderedTrackCount(page, requestedTrackCount, options = {}) {
  const timeout = Number(options.renderTimeoutMs || 10000);
  await page.waitForTimeout(750).catch(() => {});
  await page.waitForFunction((count) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const audioInputs = [...document.querySelectorAll('input[type="file"]')]
      .filter(visible)
      .filter(input => {
        const id = String(input.id || '');
        const name = String(input.getAttribute('name') || '');
        const accept = String(input.getAttribute('accept') || '');
        const classes = String(input.className || '');
        const signature = `${id} ${name} ${classes}`.toLowerCase();
        if (/artwork|cover/.test(signature) || /image/.test(accept)) return false;
        return /track|upload|audio|song/.test(signature);
      })
      .length;
    const titleInputs = [...document.querySelectorAll('input')]
      .filter(visible)
      .filter(input => /^(title_|track-title)/i.test(String(input.id || '')) || /^title_/i.test(String(input.getAttribute('name') || '')))
      .length;
    return Math.max(audioInputs, titleInputs) >= count;
  }, requestedTrackCount, { timeout }).catch(() => {});

  return page.evaluate(() => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const audioInputs = [...document.querySelectorAll('input[type="file"]')]
      .filter(visible)
      .filter(input => {
        const id = String(input.id || '');
        const name = String(input.getAttribute('name') || '');
        const accept = String(input.getAttribute('accept') || '');
        const classes = String(input.className || '');
        const signature = `${id} ${name} ${classes}`.toLowerCase();
        if (/artwork|cover/.test(signature) || /image/.test(accept)) return false;
        return /track|upload|audio|song/.test(signature);
      })
      .length;
    const titleInputs = [...document.querySelectorAll('input')]
      .filter(visible)
      .filter(input => /^(title_|track-title)/i.test(String(input.id || '')) || /^title_/i.test(String(input.getAttribute('name') || '')))
      .length;
    return Math.max(audioInputs, titleInputs);
  }).catch(() => 0);
}
