import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const SEGMENT_SECONDS = 5;
const LONG_SILENCE_THRESHOLD_SECONDS = 2.5;
const SILENCE_NOISE_FLOOR_DB = -45;
const EXEC_OPTIONS = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };

export function analyzeAudioFile(audioPath) {
  if (!audioPath) return manualReviewMetrics('Audio file path missing.');
  if (!fs.existsSync(audioPath)) return manualReviewMetrics('Audio file missing.');

  let normalizedAudioPath = null;
  try {
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      audioPath,
    ], EXEC_OPTIONS));
    const audioStream = Array.isArray(probe.streams)
      ? probe.streams.find(stream => stream.codec_type === 'audio') || probe.streams[0]
      : null;
    const format = probe.format || {};
    const durationSeconds = parsePositiveFloat(format.duration) || parsePositiveFloat(audioStream?.duration) || null;

    normalizedAudioPath = createNormalizedAudioTempFile(audioPath);
    const astatsOutput = runFfmpegStderr([
      '-hide_banner',
      '-nostats',
      '-i', normalizedAudioPath,
      '-af', 'astats=metadata=0:reset=0',
      '-f', 'null',
      '-',
    ]);
    const silenceOutput = runFfmpegStderr([
      '-hide_banner',
      '-nostats',
      '-i', normalizedAudioPath,
      '-af', `silencedetect=n=${SILENCE_NOISE_FLOOR_DB}dB:d=1.5`,
      '-f', 'null',
      '-',
    ]);
    const astats = parseAstatsOutput(astatsOutput);
    const silence = parseSilenceOutput(silenceOutput, durationSeconds);
    const segmentMetrics = durationSeconds
      ? analyzeSegments(normalizedAudioPath, durationSeconds)
      : emptySegmentMetrics();
    const clippingRatio = computeClippingRatio(astats.peakDb);
    const clippingDetected = clippingRatio > 0 || (astats.peakDb ?? -99) >= -0.25;

    return {
      ok: true,
      audioPath,
      metrics: {
        duration_seconds: durationSeconds,
        file_size_bytes: parsePositiveInt(format.size) || fs.statSync(audioPath).size,
        format: format.format_name || audioStream?.codec_name || null,
        sample_rate: parsePositiveInt(audioStream?.sample_rate),
        channels: parsePositiveInt(audioStream?.channels),
        bitrate: parsePositiveInt(format.bit_rate) || parsePositiveInt(audioStream?.bit_rate),
        integrated_loudness_lufs: null,
        peak_db: astats.peakDb,
        clipping_detected: clippingDetected,
        clipping_ratio: clippingRatio,
        total_silence_seconds: silence.totalSilenceSeconds,
        silence_start_seconds: silence.silenceStartSeconds,
        silence_end_seconds: silence.silenceEndSeconds,
        long_silence_segments: silence.longSilenceSegments,
        rms_energy_mean: segmentMetrics.rmsEnergyMean ?? astats.rmsDb,
        rms_energy_variance: segmentMetrics.rmsEnergyVariance,
        energy_curve: segmentMetrics.energyCurve,
        intro_energy_ramp: segmentMetrics.introEnergyRamp,
        high_energy_segments: segmentMetrics.highEnergySegments,
        best_clip_start_seconds: segmentMetrics.bestClipStartSeconds,
        best_clip_end_seconds: segmentMetrics.bestClipEndSeconds,
        dynamic_range_estimate: astats.dynamicRange,
        tempo_bpm: null,
        beat_confidence: null,
        brightness_score: null,
        chorus_or_peak_lift_estimate: segmentMetrics.chorusLiftEstimate,
        repeated_section_score: segmentMetrics.repeatedSectionScore,
        vocal_presence_proxy: null,
      },
    };
  } catch (error) {
    return manualReviewMetrics(`Audio analysis failed: ${error.message}`);
  } finally {
    if (normalizedAudioPath) fs.rmSync(normalizedAudioPath, { force: true });
  }
}

function createNormalizedAudioTempFile(audioPath) {
  const tempPath = path.join(os.tmpdir(), `release-selection-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-i', audioPath,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-acodec', 'pcm_s16le',
    tempPath,
    '-y',
  ], EXEC_OPTIONS);
  return tempPath;
}

function analyzeSegments(audioPath, durationSeconds) {
  const energyCurve = [];
  for (let start = 0; start < durationSeconds; start += SEGMENT_SECONDS) {
    const end = Math.min(start + SEGMENT_SECONDS, durationSeconds);
    const output = runFfmpegStderr([
      '-hide_banner',
      '-nostats',
      '-ss', String(start),
      '-t', String(Math.max(0.5, end - start)),
      '-i', audioPath,
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ]);
    const meanVolume = matchNumber(output, /mean_volume: ([-0-9.]+) dB/);
    energyCurve.push({
      start_seconds: round(start),
      rms_db: meanVolume ?? -90,
    });
  }

  if (!energyCurve.length) return emptySegmentMetrics();

  const values = energyCurve.map(item => item.rms_db);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const threshold = mean + Math.max(1.5, Math.sqrt(variance) * 0.6);
  const highEnergySegments = energyCurve
    .filter(item => item.rms_db >= threshold)
    .map(item => ({
      start_seconds: item.start_seconds,
      end_seconds: round(Math.min(item.start_seconds + SEGMENT_SECONDS, durationSeconds)),
      rms_db: item.rms_db,
    }));
  const bestSegment = [...energyCurve].sort((a, b) => b.rms_db - a.rms_db)[0];

  return {
    energyCurve,
    rmsEnergyMean: round(mean),
    rmsEnergyVariance: round(variance),
    introEnergyRamp: energyCurve.length > 1 ? round(energyCurve[1].rms_db - energyCurve[0].rms_db) : 0,
    highEnergySegments,
    bestClipStartSeconds: bestSegment ? bestSegment.start_seconds : null,
    bestClipEndSeconds: bestSegment ? round(Math.min(bestSegment.start_seconds + 15, durationSeconds)) : null,
    chorusLiftEstimate: highEnergySegments.length ? round(highEnergySegments[0].rms_db - mean) : 0,
    repeatedSectionScore: Math.min(10, highEnergySegments.length * 2),
  };
}

function runFfmpegStderr(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: EXEC_OPTIONS.maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `ffmpeg exited with code ${result.status}`);
  return result.stderr || '';
}

function emptySegmentMetrics() {
  return {
    energyCurve: [],
    rmsEnergyMean: null,
    rmsEnergyVariance: null,
    introEnergyRamp: null,
    highEnergySegments: [],
    bestClipStartSeconds: null,
    bestClipEndSeconds: null,
    chorusLiftEstimate: null,
    repeatedSectionScore: null,
  };
}

function parseAstatsOutput(output) {
  return {
    peakDb: matchNumber(output, /Peak level dB: ([-0-9.]+)/),
    rmsDb: matchNumber(output, /RMS level dB: ([-0-9.]+)/),
    dynamicRange: matchNumber(output, /Dynamic range: ([-0-9.]+)/),
  };
}

function parseSilenceOutput(output, durationSeconds) {
  const starts = [...output.matchAll(/silence_start: ([0-9.]+)/g)].map(match => Number(match[1]));
  const longSilenceSegments = [...output.matchAll(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/g)]
    .map(match => ({
      start_seconds: round(Math.max(0, Number(match[1]) - Number(match[2]))),
      end_seconds: round(Number(match[1])),
      duration_seconds: round(Number(match[2])),
    }))
    .filter(item => item.duration_seconds >= LONG_SILENCE_THRESHOLD_SECONDS);
  const totalSilenceSeconds = round(longSilenceSegments.reduce((sum, item) => sum + item.duration_seconds, 0));
  const silenceStartSeconds = starts.some(value => value <= 0.5) && longSilenceSegments.length
    ? longSilenceSegments[0].duration_seconds
    : 0;
  const silenceEndSeconds = durationSeconds && longSilenceSegments.length
    ? round(longSilenceSegments.filter(item => (durationSeconds - item.end_seconds) <= 0.75).reduce((sum, item) => sum + item.duration_seconds, 0))
    : 0;
  return { totalSilenceSeconds, silenceStartSeconds, silenceEndSeconds, longSilenceSegments };
}

function manualReviewMetrics(reason) {
  return {
    ok: false,
    error: reason,
    metrics: {
      duration_seconds: null,
      file_size_bytes: null,
      format: null,
      sample_rate: null,
      channels: null,
      bitrate: null,
      integrated_loudness_lufs: null,
      peak_db: null,
      clipping_detected: false,
      clipping_ratio: 0,
      total_silence_seconds: 0,
      silence_start_seconds: 0,
      silence_end_seconds: 0,
      long_silence_segments: [],
      rms_energy_mean: null,
      rms_energy_variance: null,
      energy_curve: [],
      intro_energy_ramp: null,
      high_energy_segments: [],
      best_clip_start_seconds: null,
      best_clip_end_seconds: null,
      dynamic_range_estimate: null,
      tempo_bpm: null,
      beat_confidence: null,
      brightness_score: null,
      chorus_or_peak_lift_estimate: null,
      repeated_section_score: null,
      vocal_presence_proxy: null,
    },
  };
}

function computeClippingRatio(peakDb) {
  if (!Number.isFinite(peakDb)) return 0;
  if (peakDb >= -0.1) return 0.03;
  if (peakDb >= -0.5) return 0.01;
  return 0;
}

function matchNumber(text, pattern) {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? round(value) : null;
}

function parsePositiveFloat(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function round(value) {
  return Number(value.toFixed(3));
}
