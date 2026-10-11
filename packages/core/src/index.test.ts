import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CARD_SLOT,
  DEFAULT_MEME_SLOT,
  DEFAULT_OUTPUT,
  MediaResourceKindSchema,
  MediaResourceV1Schema,
  ProjectV1Schema,
  ProjectV2Schema,
  ReelForgeError,
  RenderJobSchema,
  SettingsPublicSchema,
  TemplateManifestV2Schema,
  TemplateManifestV1Schema,
  TtsSynthesisRequestSchema,
  createErrorPayload,
  migrateProject,
  migrateTemplateManifest,
  safeFilename,
} from './index.js';

const projectFixture = {
  schemaVersion: 1,
  id: 'project-1',
  name: 'A project',
  templateId: 'template-1',
  tts: {
    provider: 'google',
    voiceId: 'vi-VN-Standard-A',
    speakingRate: 1,
  },
  cards: [
    {
      id: 'card-1',
      imagePath: 'assets/card-1.png',
      script: 'Xin chao',
      order: 0,
    },
  ],
};

const templateFixture = {
  schemaVersion: 1,
  id: 'template-1',
  name: 'Gameplay',
  backgroundPath: 'templates/background.mp4',
  canvas: { width: 720, height: 1280, fps: 30 },
  cardSlot: DEFAULT_CARD_SLOT,
};

describe('versioned contract entry points', () => {
  it('keeps legacy v1 speaking rates positive even outside the v2 range', () => {
    expect(ProjectV1Schema.parse({
      ...projectFixture,
      tts: { ...projectFixture.tts, speakingRate: 0.25 },
    }).tts.speakingRate).toBe(0.25);
    expect(ProjectV1Schema.parse({
      ...projectFixture,
      tts: { ...projectFixture.tts, speakingRate: 3 },
    }).tts.speakingRate).toBe(3);
  });

  it('clamps a legacy v1 speaking rate below the v2 minimum during migration', () => {
    const project = migrateProject({
      ...projectFixture,
      tts: { ...projectFixture.tts, speakingRate: 0.25 },
    });

    expect(project.tts.speakingRate).toBe(0.5);
  });

  it('clamps a legacy v1 speaking rate above the v2 maximum during migration', () => {
    const project = migrateProject({
      ...projectFixture,
      tts: { ...projectFixture.tts, speakingRate: 3 },
    });

    expect(project.tts.speakingRate).toBe(2);
  });

  it('preserves a legacy v1 speaking rate already inside the v2 range', () => {
    const project = migrateProject({
      ...projectFixture,
      tts: { ...projectFixture.tts, speakingRate: 1.5 },
    });

    expect(project.tts.speakingRate).toBe(1.5);
  });

  it('migrates a version 1 project and applies the documented output defaults', () => {
    const project = migrateProject(projectFixture);

    expect(project.schemaVersion).toBe(2);
    expect(project.output).toEqual(DEFAULT_OUTPUT);
    expect(project.cards[0]?.order).toBe(0);
    expect(project.transitionSoundPath).toBeUndefined();
    expect(project.backgroundMusicPath).toBeUndefined();
    expect(project.cards.every((card) => card.postCardMeme === undefined)).toBe(true);
  });

  it('rejects project schema versions it does not support', () => {
    expect(() => migrateProject({ ...projectFixture, schemaVersion: 3 })).toThrow(
      ReelForgeError,
    );
    expect(() => migrateProject({ ...projectFixture, schemaVersion: 3 })).toThrow(
      'Unsupported project schema version: 3',
    );
  });

  it('migrates a version 1 template manifest and applies the default sticker slot', () => {
    const manifest = migrateTemplateManifest(templateFixture);

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.memeSlot).toEqual(DEFAULT_MEME_SLOT);
    expect(manifest.canvas).toEqual({ width: 720, height: 1280, fps: 30 });
  });

  it('parses a template manifest with an omitted card slot using the documented default', () => {
    const { cardSlot: _cardSlot, ...manifestWithoutCardSlot } = templateFixture;
    const result = TemplateManifestV1Schema.safeParse(manifestWithoutCardSlot);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cardSlot).toEqual({
        x: 0.05,
        y: 0.38,
        width: 0.9,
        height: 0.25,
      });
    }
  });

  it('parses a v2 template manifest with an omitted meme slot using the v2 default', () => {
    const result = TemplateManifestV2Schema.safeParse({
      schemaVersion: 2,
      id: 'template-1',
      name: 'Gameplay',
      backgroundPath: 'templates/background.mp4',
      canvas: { width: 720, height: 1280, fps: 30 },
      cardSlot: DEFAULT_CARD_SLOT,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memeSlot).toEqual(DEFAULT_MEME_SLOT);
    }
  });

  it('rejects template manifest schema versions it does not support', () => {
    expect(() => migrateTemplateManifest({ ...templateFixture, schemaVersion: 3 })).toThrow(
      'Unsupported template manifest schema version: 3',
    );
  });

  it('requires a complete post-card meme pair and bounds project speed', () => {
    const projectV2 = {
      ...migrateProject(projectFixture),
      schemaVersion: 2 as const,
      cards: [{
        ...migrateProject(projectFixture).cards[0],
      }],
    };

    expect(() => ProjectV2Schema.parse({
      ...projectV2,
      cards: [{ ...projectV2.cards[0], postCardMeme: { imagePath: 'assets/meme.png' } }],
    })).toThrow();
    expect(() => ProjectV2Schema.parse({
      ...projectV2,
      tts: { ...projectV2.tts, speakingRate: 0.49 },
    })).toThrow();
    expect(() => ProjectV2Schema.parse({
      ...projectV2,
      tts: { ...projectV2.tts, speakingRate: 2.01 },
    })).toThrow();
  });

  it('accepts flexible card media and layout fields in a version 2 project', () => {
    const validProject = migrateProject(projectFixture);

    expect(ProjectV2Schema.parse({
      ...validProject,
      introSoundPath: 'assets/intro.mp3',
      cards: [{
        ...validProject.cards[0],
        script: '',
        holdSeconds: 3,
        layout: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 },
        postCardMeme: { videoPath: 'assets/meme.mp4', soundPath: 'assets/extra.mp3' },
      }],
    }).cards[0]?.script).toBe('');
    expect(MediaResourceKindSchema.parse('meme-video')).toBe('meme-video');
  });

  it('round-trips meme layouts and accepts intro sound resources', () => {
    const projectV2 = migrateProject(projectFixture);
    const layout = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 };

    expect(ProjectV2Schema.parse({
      ...projectV2,
      cards: [{
        ...projectV2.cards[0],
        postCardMeme: {
          imagePath: 'assets/meme.png',
          soundPath: 'assets/meme.mp3',
          layout,
        },
      }],
    }).cards[0]?.postCardMeme).toMatchObject({ layout });

    expect(ProjectV2Schema.parse({
      ...projectV2,
      cards: [{
        ...projectV2.cards[0],
        postCardMeme: {
          videoPath: 'assets/meme.mp4',
          layout,
        },
      }],
    }).cards[0]?.postCardMeme).toMatchObject({ layout });

    expect(() => ProjectV2Schema.parse({
      ...projectV2,
      cards: [{
        ...projectV2.cards[0],
        postCardMeme: {
          videoPath: 'assets/meme.mp4',
          layout: { x: 0.8, y: 0.2, width: 0.3, height: 0.3 },
        },
      }],
    })).toThrow();

    expect(MediaResourceKindSchema.parse('intro-sound')).toBe('intro-sound');
  });

  it('rejects invalid post-card visuals, hold durations, and layouts', () => {
    const validProject = migrateProject(projectFixture);
    const parseCard = (card: object) => ProjectV2Schema.parse({
      ...validProject,
      cards: [{ ...validProject.cards[0], ...card }],
    });

    expect(() => parseCard({
      postCardMeme: {
        imagePath: 'assets/meme.png',
        videoPath: 'assets/meme.mp4',
        soundPath: 'assets/extra.mp3',
      },
    })).toThrow();
    expect(() => parseCard({
      postCardMeme: { soundPath: 'assets/extra.mp3' },
    })).toThrow();
    expect(() => parseCard({
      postCardMeme: { imagePath: 'assets/meme.png' },
    })).toThrow();
    expect(() => parseCard({ holdSeconds: 0 })).toThrow();
    expect(() => parseCard({ holdSeconds: 5.01 })).toThrow();
    expect(() => parseCard({
      layout: { x: 0.1, y: 0.2, width: 0.09, height: 0.3 },
    })).toThrow();
    expect(() => parseCard({
      layout: { x: 0.1, y: 0.2, width: 0.7, height: 0.09 },
    })).toThrow();
    expect(() => parseCard({
      layout: { x: 0.4, y: 0.2, width: 0.7, height: 0.3 },
    })).toThrow();
    expect(() => parseCard({
      layout: { x: 0.1, y: 0.8, width: 0.7, height: 0.3 },
    })).toThrow();
  });

  it('accepts only an optional background music path without volume settings', () => {
    const project = migrateProject({
      ...projectFixture,
      schemaVersion: 1,
    });

    expect(ProjectV2Schema.parse({
      ...project,
      backgroundMusicPath: 'assets/music.mp3',
    }).backgroundMusicPath).toBe('assets/music.mp3');
    expect(() => ProjectV2Schema.parse({
      ...project,
      backgroundMusicPath: { path: 'assets/music.mp3', volume: 0.3 },
    })).toThrow();
  });

  it('drops a legacy fixed sticker while preserving its slot as the meme slot', () => {
    const migrated = migrateTemplateManifest({
      ...templateFixture,
      stickerPath: 'assets/legacy.png',
      stickerSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    });

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
    });
    expect(migrated).not.toHaveProperty('stickerPath');
  });

  it('normalizes legacy render-job snapshots to canonical v2 contracts', () => {
    const job = RenderJobSchema.parse({
      id: 'job-1',
      status: 'queued',
      snapshot: { project: projectFixture, template: templateFixture },
      progress: 0,
      attempts: 0,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

    expect(job.snapshot.project.schemaVersion).toBe(2);
    expect(job.snapshot.template.schemaVersion).toBe(2);
  });

  it('validates the read-only media resource contract', () => {
    expect(MediaResourceV1Schema.parse({
      schemaVersion: 1,
      id: 'meme-sound-abc',
      name: 'Klonk',
      kind: 'meme-sound',
      assetPath: 'assets/abc.mp3',
    })).toMatchObject({ kind: 'meme-sound', assetPath: 'assets/abc.mp3' });
  });
});

describe('public settings', () => {
  it('defaults valid public settings with omitted concurrency to one', () => {
    const result = SettingsPublicSchema.safeParse({
      outputDirectory: 'D:/renders',
      providers: {
        google: { ready: true, maskedKey: 'AIza…1234' },
        elevenlabs: { ready: false },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(1);
    }
  });

  it('accepts only public readiness and masked-key state for providers', () => {
    expect(
      SettingsPublicSchema.parse({
        outputDirectory: 'D:/renders',
        concurrency: 4,
        providers: {
          google: { ready: true, maskedKey: 'AIza…1234' },
          elevenlabs: { ready: false },
        },
      }),
    ).toMatchObject({ concurrency: 4, providers: { google: { ready: true } } });

    expect(() =>
      SettingsPublicSchema.parse({
        outputDirectory: 'D:/renders',
        concurrency: 1,
        providers: {
          google: { ready: true, apiKey: 'secret' },
          elevenlabs: { ready: false },
        },
      }),
    ).toThrow();
  });
});

describe('render job and provider contracts', () => {
  it('accepts a queued job with immutable project and template snapshots', () => {
    const job = RenderJobSchema.parse({
      id: 'job-1',
      status: 'queued',
      snapshot: { project: projectFixture, template: templateFixture },
      progress: 0,
      attempts: 0,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

    expect(job.snapshot.project.id).toBe('project-1');
    expect(job.status).toBe('queued');
  });

  it('rejects statuses outside the render state machine and progress above 100', () => {
    const result = RenderJobSchema.safeParse({
      id: 'job-1',
      status: 'pending',
      snapshot: { project: projectFixture, template: templateFixture },
      progress: 101,
      attempts: 0,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('keeps TTS synthesis requests serializable and rejects credentials in their payloads', () => {
    expect(
      TtsSynthesisRequestSchema.parse({
        provider: 'elevenlabs',
        voiceId: 'voice-1',
        text: 'Xin chao',
        speakingRate: 1,
        audioFormat: 'mp3',
      }),
    ).toMatchObject({ provider: 'elevenlabs', voiceId: 'voice-1' });

    expect(() =>
      TtsSynthesisRequestSchema.parse({
        provider: 'elevenlabs',
        voiceId: 'voice-1',
        text: 'Xin chao',
        speakingRate: 1,
        audioFormat: 'mp3',
        apiKey: 'secret',
      }),
    ).toThrow();
  });
});

describe('structured errors and filenames', () => {
  it('creates serializable structured error payloads without a stack or secret fields', () => {
    expect(
      createErrorPayload('INVALID_INPUT', 'A project name is required', {
        field: 'name',
      }),
    ).toEqual({
      code: 'INVALID_INPUT',
      message: 'A project name is required',
      details: { field: 'name' },
    });
  });

  it('turns a hostile display name into a portable filename with a preserved extension', () => {
    expect(safeFilename('  CON: reel / episode?.MP4  ')).toBe('CON-reel-episode.mp4');
  });

  it('uses the fallback filename when sanitization leaves no usable basename', () => {
    expect(safeFilename('...')).toBe('untitled');
  });

  it('sanitizes a caller-supplied fallback into a portable filename', () => {
    expect(safeFilename('...', '  CON: reel / episode?.MP4  ')).toBe(
      'CON-reel-episode.mp4',
    );
  });
});
