import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBrandProfile } from './brand-profile.js';
import { getBundleMarketingPack, getReleaseMarketingPack } from './release-marketing-pack.js';
import { getAllSongs, getReleaseLinks } from './db.js';
import { buildOutreachLinkBlock } from './song-marketing-kit.js';

const BRAND_PROFILE = loadBrandProfile();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

export function buildBrandSocialLinks({ releaseLinks = [] } = {}) {
  const social = BRAND_PROFILE.social || {};
  const links = [];

  pushLink(links, 'Facebook', social.facebook_url || inferFacebookUrl(social));
  pushLink(links, 'YouTube', social.youtube_channel_url || social.youtube_url || findReleaseLink(releaseLinks, ['youtube']) || getCatalogPlatformLink(['youtube']));
  pushLink(links, 'Spotify', social.spotify_artist_url || findReleaseLink(releaseLinks, ['spotify']) || getCatalogPlatformLink(['spotify']));
  pushLink(links, 'Apple Music', social.apple_music_artist_url || social.apple_music_url || findReleaseLink(releaseLinks, ['apple music']) || getCatalogPlatformLink(['apple music']));
  pushLink(links, 'Instagram', social.instagram_url);
  pushLink(links, 'TikTok', social.tiktok_url);

  return dedupeLinks(links);
}

export function buildAttachmentPlanForOutreachItem(item) {
  const packs = getPacksForItem(item);
  const primaryPack = packs[0] || {};
  const outreachType = item.outlet_context?.type || item.outlet_context?.category || 'general';
  const audience = item.release_context?.[0]?.target_age_range || '';
  const heroImage = chooseHeroImage(primaryPack, item);
  const inlineImages = heroImage?.path
    ? [{
        path: heroImage.path,
        filename: heroImage.filename,
        contentType: heroImage.contentType,
        cid: 'release-hero',
        disposition: 'inline',
      }]
    : [];
  const releaseTitles = (item.release_context || [])
    .map(release => release?.title || release?.topic || release?.id)
    .filter(Boolean);

  return {
    attachments: [],
    attachedLabels: [],
    inlineImages,
    heroImage: heroImage
      ? {
          url: heroImage.publicUrl || heroImage.url || null,
          cid: heroImage.path ? 'release-hero' : null,
          alt: heroImage.alt,
          label: heroImage.label,
        }
      : null,
    brandName: BRAND_PROFILE.brand_name || 'Pancake Robot',
    releaseTitles,
    socialLinks: buildBrandSocialLinks({
      releaseLinks: packs.flatMap(pack => pack.streaming_links || []),
    }),
    releaseLinks: dedupeLinks(
      packs.flatMap(pack => (pack.streaming_links || []).map(link => ({
        label: link.platform,
        url: link.url,
      })))
    ),
    outreachLinkBlock: buildOutreachLinkBlock({
      links: primaryPack.marketing_links || {},
      outreachType,
      audience,
    }),
    marketingLinks: primaryPack.marketing_links || {},
  };
}

export function buildHtmlBodyForOutreachItem(item) {
  const plan = buildAttachmentPlanForOutreachItem(item);
  const releaseTitle = plan.releaseTitles.length > 1
    ? `${plan.releaseTitles[0]} + ${plan.releaseTitles.length - 1} more`
    : (plan.releaseTitles[0] || item.release_context?.[0]?.title || 'New release');
  const introBlocks = draftParagraphsForHtml(item.body || '');
  const primaryLinks = prioritizeReleaseLinks(plan);
  const socialLinks = (plan.socialLinks || []).filter(link => link?.label && link?.url);
  const heroMarkup = buildHeroMarkup(plan.heroImage, releaseTitle);
  const primaryLinkMarkup = primaryLinks.length
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 0 0;"><tr>${primaryLinks.map(link => `<td style="padding:0 12px 12px 0;">${renderButton(link.label, link.url)}</td>`).join('')}</tr></table>`
    : '';
  const secondaryLinks = [
    ...primaryLinks,
    ...socialLinks.filter(link => !primaryLinks.some(primary => primary.url === link.url)),
  ];

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 10px 32px;">
                <div style="font-size:12px;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:#71717a;">${escapeHtml(plan.brandName)}</div>
                <h1 style="margin:8px 0 0 0;font-size:28px;line-height:34px;color:#111827;">${escapeHtml(releaseTitle)}</h1>
              </td>
            </tr>
            ${heroMarkup}
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                ${introBlocks}
                ${primaryLinkMarkup}
                ${secondaryLinks.length ? `
                <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e4e4e7;">
                  <div style="font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin-bottom:12px;">Release links</div>
                  ${renderLinkRows(secondaryLinks)}
                </div>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function getPacksForItem(item) {
  if (item.outreach_mode === 'bundle' && Array.isArray(item.bundle_song_ids) && item.bundle_song_ids.length) {
    const bundle = getBundleMarketingPack(item.bundle_song_ids);
    return bundle.releases || [];
  }

  if (item.song_id) return [getReleaseMarketingPack(item.song_id)];

  const releaseId = item.release_context?.[0]?.id;
  return releaseId ? [getReleaseMarketingPack(releaseId)] : [];
}

function chooseHeroImage(pack = {}, item = {}) {
  const assets = pack.marketing_assets || {};
  const releaseTitle = item.release_context?.[0]?.title || item.release_context?.[0]?.topic || item.song_id || 'release';
  const candidates = [
    ['Outreach hero', assets.outreach_banner_url],
    ['Portrait post', assets.portrait_post_url],
    ['Square post', assets.square_post_url],
    ['Vertical post', assets.vertical_post_url],
    ['Cover-safe promo', assets.cover_safe_promo_url],
    ['No-text variation', assets.no_text_variation_url],
    ['Base image', assets.base_image_url],
    ['Fallback image', assets.fallback_image_url],
  ];

  for (const [label, url] of candidates) {
    const resolved = resolveImageSource(url);
    if (!resolved) continue;
    return {
      ...resolved,
      alt: `${releaseTitle} artwork`,
      label,
    };
  }
  return null;
}

function resolveImageSource(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    return { url: value, publicUrl: value, path: null, filename: null, contentType: null };
  }
  if (value.startsWith('/media/')) {
    const relative = value.slice('/media/'.length);
    const filePath = path.join(OUTPUT_DIR, relative);
    if (!fs.existsSync(filePath)) return null;
    return {
      url: value,
      publicUrl: value,
      path: filePath,
      filename: path.basename(filePath),
      contentType: contentTypeForPath(filePath),
    };
  }
  return null;
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function draftParagraphsForHtml(body) {
  const paragraphs = String(body || '')
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .filter(block => !isLinkOnlyBlock(block));

  return paragraphs.map(block => {
    if (/^(best|thanks|thank you|warmly|cheers),?/i.test(block)) {
      return `<p style="margin:0 0 16px 0;font-size:16px;line-height:25px;color:#18181b;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`;
    }
    return `<p style="margin:0 0 16px 0;font-size:16px;line-height:25px;color:#18181b;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

function isLinkOnlyBlock(block) {
  const lines = String(block || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  if (lines.every(line => /^links?:$/i.test(line) || /^artist links?:$/i.test(line))) return true;
  return lines.every(line => /^[A-Za-z /&+-]+:\s+\S+/.test(line));
}

function prioritizeReleaseLinks(plan) {
  const preferred = [];
  const seen = new Set();
  const push = (label, url) => {
    const key = String(url || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    preferred.push({ label, url: key });
  };

  push('Listen / Stream', plan.marketingLinks?.smart_link);
  for (const label of ['Spotify', 'Apple Music', 'YouTube', 'YouTube Music']) {
    const match = (plan.releaseLinks || []).find(link => String(link.label || '').toLowerCase() === label.toLowerCase());
    push(label, match?.url);
  }
  if (preferred.length < 3) {
    for (const link of plan.releaseLinks || []) push(link.label, link.url);
  }
  return preferred.slice(0, 4);
}

function buildHeroMarkup(heroImage, releaseTitle) {
  if (!heroImage) return '';
  const src = heroImage.cid ? `cid:${heroImage.cid}` : heroImage.url;
  if (!src) return '';
  return `<tr>
    <td style="padding:8px 32px 0 32px;">
      <img src="${escapeAttribute(src)}" alt="${escapeAttribute(heroImage.alt || `${releaseTitle} artwork`)}" style="display:block;width:100%;height:auto;border:0;border-radius:16px;">
    </td>
  </tr>`;
}

function renderButton(label, url) {
  return `<a href="${escapeAttribute(url)}" style="display:inline-block;background:#111827;border-radius:999px;color:#ffffff;font-size:14px;font-weight:700;line-height:20px;padding:12px 18px;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function renderLinkRows(links = []) {
  return links.map(link => `<div style="margin:0 0 10px 0;font-size:14px;line-height:20px;">
    <span style="display:inline-block;min-width:110px;color:#71717a;">${escapeHtml(link.label || 'Link')}</span>
    <a href="${escapeAttribute(link.url)}" style="color:#0f766e;text-decoration:none;word-break:break-word;">${escapeHtml(link.url)}</a>
  </div>`).join('');
}

function pushLink(target, label, url) {
  if (!url) return;
  target.push({ label, url });
}

function dedupeLinks(links = []) {
  const seen = new Set();
  return links.filter(link => {
    const key = String(link.url || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findReleaseLink(links = [], names = []) {
  const wanted = new Set(names.map(name => String(name).toLowerCase()));
  const match = links.find(link => wanted.has(String(link.platform || '').toLowerCase()));
  return match?.url || null;
}

function inferFacebookUrl(social = {}) {
  const url = social.website_url || social.url || null;
  return /facebook\.com/i.test(String(url || '')) ? url : null;
}

function getCatalogPlatformLink(platforms = []) {
  const wanted = new Set(platforms.map(name => String(name).toLowerCase()));
  for (const song of getAllSongs()) {
    const match = getReleaseLinks(song.id).find(link => wanted.has(String(link.platform || '').toLowerCase()));
    if (match?.url) return match.url;
  }
  return null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
