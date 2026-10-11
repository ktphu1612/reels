import { vi } from 'vitest';

import type { MediaResourceV1, Project, RenderJob, SettingsPublic, TemplateManifest, TtsVoice } from '@reelforge/core';
import type { ApiClient } from '../lib/api';

export const template: TemplateManifest = {
  schemaVersion: 2,
  id: 'template-1',
  name: 'Minecraft xanh',
  backgroundPath: `assets/${'a'.repeat(64)}.mp4`,
  canvas: { width: 720, height: 1280, fps: 30 },
  cardSlot: { x: 0.05, y: 0.38, width: 0.9, height: 0.25 },
  memeSlot: { x: 0.3, y: 0.63, width: 0.4, height: 0.31 },
};

export const voices: TtsVoice[] = [
  { id: 'vi-HoaiMy', name: 'Hoài My', languageCode: 'vi-VN' },
  { id: 'vi-NamMinh', name: 'Nam Minh', languageCode: 'vi-VN' },
];

export const resources: MediaResourceV1[] = [
  { schemaVersion: 1, id: 'meme-image-1', name: 'Confused.png', kind: 'meme-image', assetPath: 'assets/confused.png' },
  { schemaVersion: 1, id: 'meme-sound-1', name: 'Bonk.mp3', kind: 'meme-sound', assetPath: 'assets/bonk.mp3' },
  { schemaVersion: 1, id: 'transition-1', name: 'Transition.mp3', kind: 'transition-sound', assetPath: 'assets/transition.mp3' },
  { schemaVersion: 1, id: 'music-1', name: 'Background.mp3', kind: 'background-music', assetPath: 'assets/music.mp3' },
];

export const baseProject: Project = {
  schemaVersion: 2,
  id: 'project-1',
  name: 'Mẹo xây nhà',
  templateId: template.id,
  tts: { provider: 'google', voiceId: voices[0].id, speakingRate: 1 },
  output: { width: 720, height: 1280, fps: 30, crf: 20 },
  cards: [],
};

export const settings: SettingsPublic = {
  outputDirectory: 'D:/reelforge/outputs',
  concurrency: 1,
  providers: {
    google: { ready: true, maskedKey: '••••••••9abc' },
    elevenlabs: { ready: false },
  },
};

export const job: RenderJob = {
  id: 'job-1',
  status: 'succeeded',
  snapshot: { project: baseProject, template },
  progress: 100,
  attempts: 1,
  createdAt: '2026-08-24T12:00:00.000Z',
  updatedAt: '2026-08-24T12:01:00.000Z',
  completedAt: '2026-08-24T12:01:00.000Z',
};

export function createMockApi(): ApiClient {
  return {
    listProjects: vi.fn().mockResolvedValue([baseProject]),
    getProject: vi.fn().mockResolvedValue(baseProject),
    createProject: vi.fn().mockResolvedValue(baseProject),
    saveProject: vi.fn().mockImplementation(async (project: Project) => project),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    duplicateProject: vi.fn().mockResolvedValue({ ...baseProject, id: 'project-2', name: 'Bản sao' }),
    importCard: vi.fn()
      .mockResolvedValueOnce({ id: 'card-1', imagePath: `assets/${'b'.repeat(64)}.webp`, script: 'Script tạm 1', order: 0 })
      .mockResolvedValueOnce({ id: 'card-2', imagePath: `assets/${'c'.repeat(64)}.webp`, script: 'Script tạm 2', order: 1 }),
    listTemplates: vi.fn().mockResolvedValue([template]),
    listResources: vi.fn(async (kind) => kind ? resources.filter((resource) => resource.kind === kind) : resources),
    getTemplate: vi.fn().mockResolvedValue(template),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    importTemplate: vi.fn().mockResolvedValue(template),
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    validateCredentials: vi.fn().mockResolvedValue({ ready: true, message: 'Đã xác thực' }),
    listVoices: vi.fn().mockResolvedValue(voices),
    previewTts: vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' })),
    listJobs: vi.fn().mockResolvedValue([job]),
    getJob: vi.fn().mockResolvedValue(job),
    enqueueProjects: vi.fn().mockResolvedValue([job]),
    cancelJob: vi.fn().mockResolvedValue({ ...job, status: 'cancelled' }),
    retryJob: vi.fn().mockResolvedValue({ ...job, status: 'queued', attempts: 2 }),
    openOutputDirectory: vi.fn().mockResolvedValue(undefined),
  };
}
