/**
 * OpenAI image generation provider (gpt-image-1 / dall-e-3).
 * Produces images with no text — text overlay is handled by canvas renderer.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const FORMAT_SIZES = {
  youtube_landscape:    { width: 1280, height: 720 },
  spotify_square:       { width: 3000, height: 3000 },
  apple_music_square:   { width: 3000, height: 3000 },
  ig_feed_1080x1350:    { width: 1080, height: 1350 },
  ig_square_1080x1080:  { width: 1080, height: 1080 },
  ig_reel_cover:        { width: 1080, height: 1920 },
  ig_story:             { width: 1080, height: 1920 },
  tiktok_cover:         { width: 1080, height: 1920 },
  ig_reel_hook:         { width: 1080, height: 1920 },
  ig_reel_lyrics:       { width: 1080, height: 1920 },
  ig_reel_character:    { width: 1080, height: 1920 },
  ig_story_new_song:    { width: 1080, height: 1920 },
  tiktok_hook:          { width: 1080, height: 1920 },
  tiktok_lyric:         { width: 1080, height: 1920 },
  tiktok_loop:          { width: 1080, height: 1920 },
};

// gpt-image-1 supports: 1024x1024, 1536x1024, 1024x1536, auto
// dall-e-3 supports: 1024x1024, 1792x1024, 1024x1792
function openaiSize(format, model) {
  const { width, height } = FORMAT_SIZES[format] || { width: 1024, height: 1024 };
  if (model === 'gpt-image-1') {
    if (width === height) return '1024x1024';
    if (width > height) return '1536x1024';
    return '1024x1536';
  }
  if (width === height) return '1024x1024';
  if (width > height) return '1792x1024';
  return '1024x1792';
}

export class OpenAIImageProvider {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  }

  async generate(format, prompt, outputPath, options = {}) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');

    const size = openaiSize(format, this.model);
    const body = JSON.stringify({
      model: this.model,
      prompt: `${prompt}. Do not include any text, words, letters, watermarks, or typography in the image.`,
      size,
      n: 1,
      response_format: 'url',
    });

    const data = await this._post('/v1/images/generations', body);
    if (!data?.data?.[0]?.url) throw new Error(`OpenAI image API returned no URL: ${JSON.stringify(data)}`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await this._download(data.data[0].url, outputPath);
    return { path: outputPath, provider: 'openai', model: this.model, format, size };
  }

  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error(`OpenAI non-JSON response: ${raw.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _download(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
  }
}
