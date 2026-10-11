import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareAudioAtSpeed } from './audio-speed.js';
import { probeMedia, resolveBundledBinaries, selectAudioDurationSeconds } from './index.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('prepareAudioAtSpeed', () => {
  it.each([
    [0.5, 4],
    [1, 2],
    [2, 1],
  ])('changes a two-second input at %sx to about %s seconds', async (rate, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-audio-speed-'));
    temporaryDirectories.push(root);
    const binaries = resolveBundledBinaries();
    const inputPath = join(root, 'input.wav');
    const outputPath = join(root, `output-${rate}.wav`);

    await execFileAsync(binaries.ffmpegPath, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:a', 'pcm_s16le', inputPath,
    ], { windowsHide: true });

    const preparedPath = await prepareAudioAtSpeed(inputPath, outputPath, rate, {
      binaryResolver: () => binaries,
    });
    const probe = await probeMedia(preparedPath, { binaryResolver: () => binaries });

    expect(selectAudioDurationSeconds(probe)).toBeCloseTo(expected, 1);
    expect(preparedPath).toBe(rate === 1 ? inputPath : outputPath);
  }, 60_000);

  it('rejects a rate outside the project range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reelforge-audio-speed-invalid-'));
    temporaryDirectories.push(root);

    await expect(prepareAudioAtSpeed(
      join(root, 'input.mp3'),
      join(root, 'output.wav'),
      2.01,
      {},
    )).rejects.toMatchObject({ payload: { code: 'INVALID_INPUT' } });
  });
});
