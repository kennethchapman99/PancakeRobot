/**
 * Image provider abstraction. Selects the configured provider and delegates.
 * No text is generated in image prompts — text overlay is handled by the
 * deterministic canvas renderer (simple-renderer.js).
 */

import { OpenAIImageProvider } from './openai-image-provider.js';
import { CloudflareImageProvider } from './cloudflare-image-provider.js';

const PROVIDERS = {
  openai: OpenAIImageProvider,
  cloudflare: CloudflareImageProvider,
};

export function getImageProvider(providerName) {
  const name = providerName || process.env.MARKETING_IMAGE_PROVIDER || 'openai';
  const Cls = PROVIDERS[name];
  if (!Cls) throw new Error(`Unknown image provider: ${name}. Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  return new Cls();
}

export async function generateSocialImage(format, prompt, outputPath, options = {}) {
  const providerName = options.provider || process.env.MARKETING_IMAGE_PROVIDER || 'openai';
  const provider = getImageProvider(providerName);
  return provider.generate(format, prompt, outputPath, options);
}
