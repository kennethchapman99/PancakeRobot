import { createWorkflowRunId } from '../../../packages/openclaw-core/index.js';
import { runMagicSongWorkflow } from '../../workflows/magic-song-workflow.js';
import { buildBrandKeyboard, findBrandChoice, parseBrandCallback } from './brand-selector.js';
import {
  clearPendingBrandProfile,
  clearPendingMagicSong,
  clearTelegramSessionWork,
  getTelegramSession,
  updateTelegramSession,
} from './session-store.js';
import { getHelpText, parseTelegramCommand } from './commands.js';
import { buildSongPublicLinks } from '../../shared/song-public-links.js';
import {
  buildTelegramMagicSongIdempotencyKey,
  createTelegramRequestLock,
  updateTelegramRequestLock,
} from '../../shared/telegram-session-db.js';
import {
  generateBrandProfileFromPrompt,
  installBrandProfile,
  slugifyBrandName,
  summarizeBrandProfile,
} from '../../services/brand-profile-installer.js';

const NOT_AUTHORIZED_MESSAGE = 'This bot is not authorized for this Telegram account.';

export async function handleTelegramMessage({ telegram, message, allowedUserIds }) {
  const fromId = String(message?.from?.id || '');
  const chatId = message?.chat?.id;
  const text = message?.text || '';
  const cleanText = String(text || '').trim();

  if (!isAuthorized(fromId, allowedUserIds)) {
    await telegram.sendMessage(chatId, NOT_AUTHORIZED_MESSAGE);
    return;
  }

  if (/^\/start\b/i.test(cleanText) || /^\/help\b/i.test(cleanText)) {
    await telegram.sendMessage(chatId, getHelpText());
    return;
  }

  if (/^\/cancel\b/i.test(cleanText) || /^\/brand\s+cancel\b/i.test(cleanText)) {
    clearTelegramSessionWork(chatId);
    await telegram.sendMessage(chatId, 'Canceled the pending Telegram request.');
    return;
  }

  if (/^\/brands\b/i.test(cleanText) || /^\/brand\s+list\b/i.test(cleanText)) {
    await telegram.sendMessage(chatId, 'Choose a brand profile:', { reply_markup: buildBrandKeyboard() });
    return;
  }

  if (/^\/brand\s+new\b/i.test(cleanText)) {
    await startBrandProfileCreation({ telegram, chatId, fromId, messageId: message.message_id });
    return;
  }

  const session = getTelegramSession(chatId);
  if (session.pendingBrandProfile) {
    await handleBrandProfileCreationMessage({
      telegram,
      chatId,
      fromId,
      messageId: message.message_id,
      text: cleanText,
      pending: session.pendingBrandProfile,
    });
    return;
  }

  const command = parseTelegramCommand(text);

  if (command.type === 'help') {
    await telegram.sendMessage(chatId, getHelpText());
    return;
  }

  if (command.type === 'cancel') {
    clearPendingMagicSong(chatId);
    await telegram.sendMessage(chatId, 'Canceled the pending Magic Song request.');
    return;
  }

  if (command.type === 'brands') {
    await telegram.sendMessage(chatId, 'Choose a brand profile:', { reply_markup: buildBrandKeyboard() });
    return;
  }

  if (command.type === 'brand_profile_new') {
    await startBrandProfileCreation({ telegram, chatId, fromId, messageId: message.message_id });
    return;
  }

  if (command.type === 'magic_song_request') {
    updateTelegramSession(chatId, {
      userId: fromId,
      lastMessageId: message.message_id,
      pendingMagicSong: {
        theme: command.theme,
        requestedBy: fromId,
        sourceMessageId: message.message_id,
        createdAt: new Date().toISOString(),
      },
    });

    await telegram.sendMessage(
      chatId,
      `Theme received:\n${command.theme}\n\nChoose the brand profile to apply:`,
      { reply_markup: buildBrandKeyboard() }
    );
    return;
  }

  await telegram.sendMessage(chatId, getHelpText());
}

export async function handleTelegramCallback({ telegram, callbackQuery, allowedUserIds }) {
  const fromId = String(callbackQuery?.from?.id || '');
  const chatId = callbackQuery?.message?.chat?.id;
  const callbackData = callbackQuery?.data || '';

  if (!isAuthorized(fromId, allowedUserIds)) {
    await telegram.answerCallbackQuery(callbackQuery.id, 'Not authorized.');
    await telegram.sendMessage(chatId, NOT_AUTHORIZED_MESSAGE);
    return;
  }

  const brandId = parseBrandCallback(callbackData);
  if (!brandId) {
    await telegram.answerCallbackQuery(callbackQuery.id, 'Unknown action.');
    return;
  }

  const brand = findBrandChoice(brandId);
  if (!brand) {
    await telegram.answerCallbackQuery(callbackQuery.id, 'Brand profile not found.');
    await telegram.sendMessage(chatId, `Brand profile not found: ${brandId}`);
    return;
  }

  const session = getTelegramSession(chatId);
  const pending = session.pendingMagicSong;
  if (!pending?.theme) {
    await telegram.answerCallbackQuery(callbackQuery.id, 'No pending theme.');
    await telegram.sendMessage(chatId, 'No pending Magic Song theme. Send me a theme first.');
    return;
  }

  const idempotencyKey = buildTelegramMagicSongIdempotencyKey({
    chatId,
    messageId: pending.sourceMessageId,
    callbackQueryId: callbackQuery.id,
    brandId,
  });
  const runId = createWorkflowRunId('MAGIC');
  const lock = createTelegramRequestLock({
    idempotencyKey,
    chatId,
    userId: fromId,
    sourceMessageId: pending.sourceMessageId,
    callbackQueryId: callbackQuery.id,
    runId,
  });

  if (!lock.inserted) {
    await telegram.answerCallbackQuery(callbackQuery.id, 'Already started.');
    const existingRunId = lock.lock?.run_id;
    await telegram.sendMessage(
      chatId,
      existingRunId
        ? `This Magic Song request is already running or complete.\nRun: ${existingRunId}`
        : 'This Magic Song request is already running or complete.'
    );
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id, `Starting ${brand.name}.`);
  await telegram.sendMessage(chatId, `Confirmed: ${brand.name}\nStarting Magic Song pipeline.`);

  clearPendingMagicSong(chatId);

  try {
    updateTelegramRequestLock(idempotencyKey, { status: 'running', runId });
    const workflowState = await runMagicSongWorkflow({
      theme: pending.theme,
      brandId,
      requestedBy: fromId,
      source: 'telegram',
      mode: process.env.TELEGRAM_MAGIC_MODE || 'human_review',
      runId,
      idempotencyKey,
    }, {
      onEvent: event => sendProgressEvent({ telegram, chatId, event }),
    });

    const result = workflowState.result || workflowState.stepResults?.hydrate_result;
    updateTelegramRequestLock(idempotencyKey, { status: 'completed', runId: result?.runId || runId });
    await telegram.sendMessage(chatId, formatFinalResult(result));
  } catch (error) {
    updateTelegramRequestLock(idempotencyKey, { status: 'failed', runId });
    const errorRunId = error?.context?.runId || runId || 'saved in workflow logs if the run started';
    await telegram.sendMessage(
      chatId,
      `Song generation failed.\n\nStage/error: ${error.message}\nRun: ${errorRunId}`
    );
  }
}

async function startBrandProfileCreation({ telegram, chatId, fromId, messageId }) {
  console.log('[telegram-brand] starting profile creation');
  clearPendingMagicSong(chatId);
  updateTelegramSession(chatId, {
    userId: fromId,
    lastMessageId: messageId,
    pendingBrandProfile: {
      step: 'awaiting_brand_name',
      requestedBy: fromId,
      createdAt: new Date().toISOString(),
    },
  });

  await telegram.sendMessage(chatId, 'What should this brand be called?');
}

async function handleBrandProfileCreationMessage({ telegram, chatId, fromId, messageId, text, pending }) {
  if (!text) {
    await telegram.sendMessage(chatId, 'Send text for the current brand profile step, or /cancel.');
    return;
  }

  if (pending.step === 'awaiting_brand_name') {
    let brandId;
    try {
      brandId = slugifyBrandName(text);
    } catch (error) {
      await telegram.sendMessage(chatId, error.message);
      return;
    }

    updateTelegramSession(chatId, {
      userId: fromId,
      lastMessageId: messageId,
      pendingBrandProfile: {
        ...pending,
        step: 'awaiting_brand_description',
        brandName: text,
        brandId,
        updatedAt: new Date().toISOString(),
      },
    });

    await telegram.sendMessage(
      chatId,
      `Brand name: ${text}\nBrand ID: ${brandId}\n\nSend me the brand description / vibe / audience / music direction.`
    );
    return;
  }

  if (pending.step === 'awaiting_brand_description') {
    await telegram.sendMessage(chatId, `Creating brand profile “${pending.brandName}”.`);

    try {
      const profile = await generateBrandProfileFromPrompt({
        brandName: pending.brandName,
        brandId: pending.brandId,
        description: text,
      });

      updateTelegramSession(chatId, {
        userId: fromId,
        lastMessageId: messageId,
        pendingBrandProfile: {
          ...pending,
          step: 'awaiting_install_confirmation',
          description: text,
          generatedProfile: profile,
          updatedAt: new Date().toISOString(),
        },
      });

      await telegram.sendMessage(
        chatId,
        `${summarizeBrandProfile(profile, pending.brandId)}\n\nReply with:\ninstall\nregenerate\ncancel`
      );
    } catch (error) {
      console.error('[telegram-brand] generation failed', error);
      await telegram.sendMessage(chatId, `Brand profile generation failed: ${error.message}`);
    }
    return;
  }

  if (pending.step === 'awaiting_install_confirmation' || pending.step === 'awaiting_overwrite_confirmation') {
    const action = text.toLowerCase();

    if (action === 'cancel') {
      clearPendingBrandProfile(chatId);
      await telegram.sendMessage(chatId, 'Canceled brand profile creation.');
      return;
    }

    if (action === 'regenerate') {
      await telegram.sendMessage(chatId, `Regenerating brand profile “${pending.brandName}”.`);
      try {
        const profile = await generateBrandProfileFromPrompt({
          brandName: pending.brandName,
          brandId: pending.brandId,
          description: pending.description,
        });

        updateTelegramSession(chatId, {
          userId: fromId,
          lastMessageId: messageId,
          pendingBrandProfile: {
            ...pending,
            step: 'awaiting_install_confirmation',
            generatedProfile: profile,
            updatedAt: new Date().toISOString(),
          },
        });

        await telegram.sendMessage(
          chatId,
          `${summarizeBrandProfile(profile, pending.brandId)}\n\nReply with:\ninstall\nregenerate\ncancel`
        );
      } catch (error) {
        console.error('[telegram-brand] regeneration failed', error);
        await telegram.sendMessage(chatId, `Brand profile regeneration failed: ${error.message}`);
      }
      return;
    }

    if (action === 'install' || action === 'overwrite') {
      const overwrite = action === 'overwrite' || pending.step === 'awaiting_overwrite_confirmation';
      try {
        const installed = installBrandProfile({
          brandId: pending.brandId,
          profile: pending.generatedProfile,
          overwrite,
        });
        clearPendingBrandProfile(chatId);
        await telegram.sendMessage(
          chatId,
          `Created and installed “${installed.profile.brand_name}”.\nBrand ID: ${installed.brandId}\n\nIt is now available as a brand option when creating a new song.`
        );
      } catch (error) {
        if (error.code === 'BRAND_PROFILE_EXISTS') {
          updateTelegramSession(chatId, {
            userId: fromId,
            lastMessageId: messageId,
            pendingBrandProfile: {
              ...pending,
              step: 'awaiting_overwrite_confirmation',
              updatedAt: new Date().toISOString(),
            },
          });
          await telegram.sendMessage(
            chatId,
            `Brand ID already exists: ${pending.brandId}\n\nReply overwrite to replace it, regenerate to create a new draft, or cancel.`
          );
          return;
        }

        console.error('[telegram-brand] install failed', error);
        await telegram.sendMessage(chatId, `Brand profile install failed: ${error.message}`);
      }
      return;
    }

    await telegram.sendMessage(chatId, 'Reply with install, regenerate, or cancel.');
    return;
  }

  clearPendingBrandProfile(chatId);
  await telegram.sendMessage(chatId, 'Brand profile state was invalid, so I cleared it. Send /brand new to start again.');
}

async function sendProgressEvent({ telegram, chatId, event }) {
  if (event.type === 'workflow_started') {
    await telegram.sendMessage(chatId, 'Theme received. Workflow started.');
    return;
  }

  if (event.type === 'step_completed' && event.stepId === 'load_brand_profile') {
    await telegram.sendMessage(chatId, `Brand loaded: ${event.result?.brandName || event.result?.brandId}`);
    return;
  }

  if (event.type === 'pipeline_progress') {
    const message = formatPipelineStage(event.stage);
    if (message) await telegram.sendMessage(chatId, message);
  }

  if (event.type === 'workflow_failed') {
    await telegram.sendMessage(chatId, `Magic Song workflow failed: ${event.error?.message || 'unknown error'}`);
  }
}

function formatPipelineStage(stage) {
  switch (stage) {
    case 'writing_song_brief': return 'Writing song brief and lyrics.';
    case 'generating_audio': return 'Generating audio.';
    case 'scoring_song': return 'Scoring song with release-selection agent.';
    case 'creating_release_assets': return 'Creating release kit / marketing assets.';
    case 'done': return 'Magic Song pipeline complete.';
    default: return null;
  }
}

export function formatFinalResult(result = {}) {
  const links = result.songId ? buildSongPublicLinks(result.songId) : {};
  const title = result.title || result.songId || 'Magic Song';
  const audioUrl = result.audioUrl || links.audioUrl;
  const detailUrl = result.detailUrl || result.previewUrl || links.detailUrl;
  const releaseKitUrl = result.releaseKitUrl || links.releaseKitUrl;
  const publicBaseConfigured = result.publicBaseConfigured ?? links.publicBaseConfigured;
  const isLocalBaseUrl = result.isLocalBaseUrl ?? links.isLocalBaseUrl;

  const lines = [
    `🎵 Song ready: ${title}`,
    '',
  ];

  if (audioUrl) {
    lines.push('▶️ Listen / download MP3:', audioUrl, '');
  }

  if (detailUrl) {
    lines.push('📄 Song details:', detailUrl, '');
  }

  if (releaseKitUrl) {
    lines.push('📦 Release kit:', releaseKitUrl, '');
  }

  if (result.score !== null && result.score !== undefined) lines.push(`Score: ${result.score}`);
  if (result.status) lines.push(`Recommendation: ${result.status}`);

  if (Array.isArray(result.rationale) && result.rationale.length) {
    lines.push('', 'Why:');
    for (const item of result.rationale.slice(0, 4)) lines.push(`- ${item}`);
  }

  if (!publicBaseConfigured || isLocalBaseUrl) {
    lines.push('', '⚠️ Public URL not configured. Set PUBLIC_BASE_URL or NGROK_URL so these links work outside your home network.');
  }

  if (result.runId) lines.push('', `Run: ${result.runId}`);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isAuthorized(fromId, allowedUserIds) {
  return allowedUserIds.has(String(fromId));
}
