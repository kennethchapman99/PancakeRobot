import { listBrandProfiles } from '../../shared/brand-profile.js';

export function getTelegramBrandChoices() {
  return listBrandProfiles().map(profile => ({
    id: profile.id,
    name: profile.name,
    label: profile.isDefault ? `${profile.name} (default)` : profile.name,
  }));
}

export function buildBrandKeyboard() {
  return {
    inline_keyboard: getTelegramBrandChoices().map(profile => ([{
      text: profile.label,
      callback_data: `brand:${profile.id}`,
    }])),
  };
}

export function parseBrandCallback(callbackData) {
  const raw = String(callbackData || '');
  if (!raw.startsWith('brand:')) return null;
  return raw.slice('brand:'.length).trim() || null;
}

export function findBrandChoice(brandId) {
  return getTelegramBrandChoices().find(choice => choice.id === brandId) || null;
}
