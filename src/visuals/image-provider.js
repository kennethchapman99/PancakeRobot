/**
 * Image provider abstraction. Selects the configured provider and delegates.
 * No text is generated in image prompts — text overlay is handled by the
 * deterministic canvas renderer (simple-renderer.js).
 */

import { OpenAIImageProvider } from './openai-image-provider.js';
import { CloudflareImageProvider } from './cloudflare-image-provider.js';

const PRIMARY_PROVIDERS = {
  openai: OpenAIImageProvider,
};
const LEGACY_PROVIDERS = {
  cloudflare: CloudflareImageProvider,
};

export function getImageProvider(providerName) {
  const name = providerName || process.env.MARKETING_IMAGE_PROVIDER || 'openai';
  const providers = process.env.PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE === '1'
    ? { ...PRIMARY_PROVIDERS, ...LEGACY_PROVIDERS }
    : PRIMARY_PROVIDERS;
  const Cls = providers[name];
  if (!Cls) throw new Error(`Unknown image provider: ${name}. Supported: ${Object.keys(providers).join(', ')}`);
  return new Cls();
}

export async function generateSocialImage(format, prompt, outputPath, options = {}) {
  const providerName = options.provider || process.env.MARKETING_IMAGE_PROVIDER || 'openai';
  const provider = getImageProvider(providerName);
  return provider.generate(format, prompt, outputPath, options);
}
