/**
 * Cloudflare Workers AI image generation provider.
 * Uses Cloudflare AI REST API — no SDK dependency.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

export class CloudflareImageProvider {
  constructor() {
    this.accountId = process.env.CF_ACCOUNT_ID;
    this.apiToken = process.env.CF_API_TOKEN;
    this.model = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
  }

  async generate(format, prompt, outputPath, options = {}) {
    if (!this.accountId) throw new Error('CF_ACCOUNT_ID is not set');
    if (!this.apiToken) throw new Error('CF_API_TOKEN is not set');

    const body = JSON.stringify({
      prompt: `${prompt}. No text, no words, no letters, no watermarks.`,
      num_steps: 20,
    });

    const endpoint = `/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
    const imageBuffer = await this._post(endpoint, body);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, imageBuffer);
    return { path: outputPath, provider: 'cloudflare', model: this.model, format };
  }

  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const req = https.request({
        hostname: 'api.cloudflare.com',
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // Cloudflare returns raw image bytes for image models
          if (res.headers['content-type']?.includes('image')) {
            resolve(buf);
          } else {
            try {
              const parsed = JSON.parse(buf.toString());
              reject(new Error(`Cloudflare AI error: ${JSON.stringify(parsed)}`));
            } catch {
              reject(new Error(`Cloudflare non-image response (status ${res.statusCode})`));
            }
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
