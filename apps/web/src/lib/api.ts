import {
  ProjectCardV2Schema,
  ProjectSchema,
  RenderJobSchema,
  MediaResourceKindSchema,
  MediaResourceV1Schema,
  SettingsPublicSchema,
  StructuredErrorCodeSchema,
  TemplateManifestSchema,
  TtsCredentialValidationResultSchema,
  TtsListVoicesResultSchema,
  TtsVoiceSchema,
  type ProjectCard,
  type ProjectTtsSettings,
  type Project,
  type RenderJob,
  type MediaResourceKind,
  type MediaResourceV1,
  type SettingsPublic,
  type StructuredErrorCode,
  type TemplateManifest,
  type TtsCredentialValidationResult,
  type TtsProviderId,
  type TtsVoice,
} from '@reelforge/core';
import { z, type ZodType } from 'zod';

const ErrorPayloadSchema = z.object({
  code: StructuredErrorCodeSchema,
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ProjectsResponseSchema = z.object({ projects: z.array(ProjectSchema) }).strict();
const TemplatesResponseSchema = z.object({ templates: z.array(TemplateManifestSchema) }).strict();
const VoicesResponseSchema = z.object({ voices: z.array(TtsVoiceSchema) }).strict();
const JobsResponseSchema = z.object({ jobs: z.array(RenderJobSchema) }).strict();
const EnqueueResponseSchema = z.object({ jobs: z.array(RenderJobSchema) }).strict();
const ResourcesResponseSchema = z.object({ resources: z.array(MediaResourceV1Schema) }).strict();

const ERROR_MESSAGES: Record<StructuredErrorCode, string> = {
  INVALID_INPUT: 'Dữ liệu chưa hợp lệ.',
  UNSUPPORTED_SCHEMA_VERSION: 'Dữ liệu này không tương thích với phiên bản hiện tại.',
  NOT_FOUND: 'Không tìm thấy project.',
  CONFLICT: 'Dữ liệu vừa thay đổi, hãy thử lại.',
  UNAUTHORIZED: 'Thông tin xác thực chưa đúng.',
  PROVIDER_UNAVAILABLE: 'Nhà cung cấp TTS đang tạm thời không khả dụng.',
  RENDER_FAILED: 'Render thất bại. Hãy kiểm tra script và template.',
  CANCELLED: 'Tác vụ đã được huỷ.',
  INTERNAL: 'Không thể hoàn tất yêu cầu lúc này.',
};

export class ApiError extends Error {
  readonly code: StructuredErrorCode;
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(code: StructuredErrorCode, status: number, details?: Record<string, unknown>) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assetUrl(relativePath: string): string {
  const filename = relativePath.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  if (!filename) return '/api/assets/invalid';
  return `/api/assets/${encodeURIComponent(filename)}`;
}

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: { name: string; templateId: string; tts: ProjectTtsSettings }): Promise<Project>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  duplicateProject(id: string, name: string): Promise<Project>;
  importCard(projectId: string, image: File, script: string): Promise<ProjectCard>;
  listTemplates(): Promise<TemplateManifest[]>;
  listResources(kind?: MediaResourceKind): Promise<MediaResourceV1[]>;
  getTemplate(id: string): Promise<TemplateManifest>;
  deleteTemplate(id: string): Promise<void>;
  importTemplate(input: {
    name: string;
    background: File;
    thumbnail?: File;
  }): Promise<TemplateManifest>;
  getSettings(): Promise<SettingsPublic>;
  updateSettings(input: Record<string, unknown>): Promise<SettingsPublic>;
  validateCredentials(provider: TtsProviderId): Promise<TtsCredentialValidationResult>;
  listVoices(provider: TtsProviderId, languageCode?: string): Promise<TtsVoice[]>;
  previewTts(input: {
    provider: TtsProviderId;
    voiceId: string;
    modelId?: string;
    text: string;
    speakingRate: number;
  }): Promise<Blob>;
  listJobs(): Promise<RenderJob[]>;
  getJob(id: string): Promise<RenderJob>;
  enqueueProjects(projectIds: string[]): Promise<RenderJob[]>;
  cancelJob(id: string): Promise<RenderJob>;
  retryJob(id: string): Promise<RenderJob>;
  openOutputDirectory(): Promise<void>;
}

export interface ResourceApiClient extends ApiClient {
  listResources(kind?: MediaResourceKind): Promise<MediaResourceV1[]>;
}

export function createApiClient(fetchImpl: typeof fetch = globalThis.fetch): ResourceApiClient {
  async function request<T>(path: string, init: RequestInit, schema?: ZodType<T>, responseType: 'json' | 'blob' = 'json'): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(path, init);
    } catch {
      throw new ApiError('INTERNAL', 0);
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const parsed = ErrorPayloadSchema.safeParse(payload);
      if (parsed.success) {
        throw new ApiError(parsed.data.code, response.status, parsed.data.details);
      }
      throw new ApiError(response.status === 404 ? 'NOT_FOUND' : 'INTERNAL', response.status);
    }

    if (response.status === 204) return undefined as T;
    if (responseType === 'blob') return (await response.blob()) as T;
    if (schema === undefined) return (await response.json()) as T;
    const payload = await response.json();
    return schema.parse(payload);
  }

  const get = <T>(path: string, schema: ZodType<T>) => request(path, { method: 'GET' }, schema);
  const json = <T>(path: string, method: 'POST' | 'PUT', body: unknown, schema: ZodType<T>) => request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    schema,
  );

  return {
    async listProjects() {
      const response = await get('/api/projects', ProjectsResponseSchema);
      return response.projects;
    },
    getProject: (id) => get(`/api/projects/${encodeURIComponent(id)}`, ProjectSchema),
    createProject: (input) => json('/api/projects', 'POST', input, ProjectSchema),
    saveProject: (project) => json(`/api/projects/${encodeURIComponent(project.id)}`, 'PUT', project, ProjectSchema),
    async deleteProject(id) {
      await request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    duplicateProject: (id, name) => json(`/api/projects/${encodeURIComponent(id)}/duplicate`, 'POST', { name }, ProjectSchema),
    async importCard(projectId, image, script) {
      const form = new FormData();
      form.set('image', image);
      form.set('script', script);
      return request(`/api/projects/${encodeURIComponent(projectId)}/cards`, { method: 'POST', body: form }, ProjectCardV2Schema);
    },
    async listTemplates() {
      const response = await get('/api/templates', TemplatesResponseSchema);
      return response.templates;
    },
    async listResources(kind) {
      const query = kind === undefined
        ? ''
        : `?${new URLSearchParams({ kind: MediaResourceKindSchema.parse(kind) }).toString()}`;
      const response = await get(`/api/resources${query}`, ResourcesResponseSchema);
      return response.resources;
    },
    getTemplate: (id) => get(`/api/templates/${encodeURIComponent(id)}`, TemplateManifestSchema),
    async deleteTemplate(id) {
      await request<void>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async importTemplate(input) {
      const form = new FormData();
      form.set('name', input.name);
      form.set('background', input.background);
      if (input.thumbnail) form.set('thumbnail', input.thumbnail);
      return request('/api/templates/import', { method: 'POST', body: form }, TemplateManifestSchema);
    },
    getSettings: () => get('/api/settings', SettingsPublicSchema),
    updateSettings: (input) => json('/api/settings', 'PUT', input, SettingsPublicSchema),
    validateCredentials: (provider) => json('/api/tts/credentials/validate', 'POST', { provider }, TtsCredentialValidationResultSchema),
    async listVoices(provider, languageCode = 'vi-VN') {
      const params = new URLSearchParams({ provider, languageCode });
      const response = await get(`/api/tts/voices?${params.toString()}`, VoicesResponseSchema);
      return response.voices;
    },
    previewTts: (input) => request('/api/tts/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, audioFormat: 'mp3' }) }, undefined, 'blob'),
    async listJobs() {
      const response = await get('/api/jobs', JobsResponseSchema);
      return response.jobs.map(stripOutputPath);
    },
    async getJob(id) {
      return stripOutputPath(await get(`/api/jobs/${encodeURIComponent(id)}`, RenderJobSchema));
    },
    async enqueueProjects(projectIds) {
      const response = await json('/api/jobs/enqueue', 'POST', { projectIds: [...new Set(projectIds)] }, EnqueueResponseSchema);
      return response.jobs.map(stripOutputPath);
    },
    cancelJob: async (id) => stripOutputPath(await json(`/api/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}, RenderJobSchema)),
    retryJob: async (id) => stripOutputPath(await json(`/api/jobs/${encodeURIComponent(id)}/retry`, 'POST', {}, RenderJobSchema)),
    async openOutputDirectory() {
      await request<void>('/api/system/open-output-directory', { method: 'POST' });
    },
  };
}

function stripOutputPath(job: RenderJob): RenderJob {
  if (!job.outputPath) return job;
  const { outputPath: _outputPath, ...safeJob } = job;
  return safeJob as RenderJob;
}
