import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import multipart from '@fastify/multipart';
import {
  ProjectV2Schema,
  ReelForgeError,
  RenderJobSchema,
  RenderJobSnapshotSchema,
  MediaResourceKindSchema,
  TtsCredentialValidationRequestSchema,
  TtsListVoicesRequestSchema,
  TtsProviderIdSchema,
  TtsSynthesisRequestSchema,
  createErrorPayload,
  safeFilename,
  type StructuredErrorPayload,
  type TtsProvider,
  type TtsProviderId,
} from '@reelforge/core';
import { redactSensitiveText, type QueueStore } from '@reelforge/queue';
import { prepareAudioAtSpeed } from '@reelforge/renderer';
import type { AppPaths, ProjectStore, ResourceStore, TemplateStore } from '@reelforge/storage';
import { createBaseSynthesisRequest, type EnvSecretStore, type TtsCache } from '@reelforge/tts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';

export interface ServerDependencies {
  readonly paths: AppPaths;
  readonly resources?: ResourceStore;
  readonly projects: ProjectStore;
  readonly templates: TemplateStore;
  readonly queue: QueueStore;
  readonly secrets: EnvSecretStore;
  readonly providers: Record<TtsProviderId, TtsProvider>;
  readonly cache: TtsCache;
  readonly openOutputDirectory: (path: string) => Promise<void>;
  readonly refreshRedactionValues?: () => Promise<void>;
  readonly redactValues?: () => readonly string[];
  readonly eventPollIntervalMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
  readonly staticDirectory?: string;
  readonly webRoot?: string;
}

const IdParamsSchema = z.object({ id: z.string().min(1) }).strict();
const AssetParamsSchema = z.object({
  filename: z.string().regex(/^[a-f0-9]{64}\.(?:png|jpg|webp|mp3|webm|mov|mp4)$/),
}).strict();
const ResourceListQuerySchema = z.object({ kind: MediaResourceKindSchema.optional() }).strict();
const ProjectCreateSchema = z.object({
  name: z.string().trim().min(1),
  templateId: z.string().min(1),
  tts: ProjectV2Schema.shape.tts,
}).strict();
const DuplicateSchema = z.object({ name: z.string().trim().min(1) }).strict();
const EnqueueSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1).refine((ids) => new Set(ids).size === ids.length, {
    message: 'Project IDs must be unique',
  }),
}).strict();
const SettingsUpdateSchema = z.object({
  outputDirectory: z.string().trim().min(1).optional(),
  concurrency: z.number().int().min(1).max(4).optional(),
  googleApiKey: z.string().min(1).nullable().optional(),
  elevenlabsApiKey: z.string().min(1).nullable().optional(),
}).strict();

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const sseCleanups = new Set<(closeResponse?: boolean) => void>();
  void app.register(multipart, {
    limits: { files: 3, fields: 10, fileSize: 250 * 1024 * 1024, parts: 13 },
  });

  app.setErrorHandler((error, _request, reply) => {
    const { status, payload } = publicError(error, dependencies.redactValues?.() ?? []);
    void reply.status(status).send(payload);
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/resources', async (request) => {
    const { kind } = parse(ResourceListQuerySchema, request.query);
    return { resources: dependencies.resources ? await dependencies.resources.list(kind) : [] };
  });

  app.get('/api/assets/:filename', async (request, reply) => {
    const { filename } = parse(AssetParamsSchema, request.params);
    const assetPath = join(dependencies.paths.assets, filename);
    let size: number;
    try {
      const information = await stat(assetPath);
      if (!information.isFile()) throw new Error('not a file');
      size = information.size;
    } catch {
      throw new ReelForgeError(createErrorPayload('NOT_FOUND', 'Asset was not found'));
    }
    const rangeHeader = request.headers.range;
    const range = parseByteRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, size);
    reply.headers({
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'content-type': assetContentType(filename),
    });
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(createReadStream(assetPath, { start: range.start, end: range.end }));
    }
    return reply.header('content-length', String(size)).send(createReadStream(assetPath));
  });

  app.get('/api/projects', async () => ({ projects: await dependencies.projects.list() }));
  app.post('/api/projects', async (request, reply) => {
    const body = parse(ProjectCreateSchema, request.body);
    const project = await dependencies.projects.create(body);
    return reply.status(201).send(project);
  });
  app.get('/api/projects/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return dependencies.projects.get(id);
  });
  app.put('/api/projects/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const project = parse(ProjectV2Schema, request.body);
    if (project.id !== id) throw invalidInput('Project ID must match the route');
    return dependencies.projects.save(project);
  });
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await dependencies.projects.delete(id);
    return reply.status(204).send();
  });
  app.post('/api/projects/:id/duplicate', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const { name } = parse(DuplicateSchema, request.body);
    return reply.status(201).send(await dependencies.projects.duplicate(id, name));
  });
  app.post('/api/projects/:id/cards', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const upload = await collectMultipart(request, dependencies.paths);
    let card;
    try {
      assertOnlyFields(upload, ['script'], ['image']);
      const script = parse(z.string(), upload.fields.script);
      const imagePath = requiredUpload(upload, 'image');
      card = await dependencies.projects.importCardImage(id, imagePath, script);
    } finally {
      await upload.cleanup();
    }
    return reply.status(201).send(card);
  });
  app.post('/api/projects/import', async (request, reply) => {
    return reply.status(201).send(await dependencies.projects.import(request.body));
  });

  app.get('/api/templates', async () => ({ templates: await dependencies.templates.list() }));
  app.get('/api/templates/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return dependencies.templates.get(id);
  });
  app.delete('/api/templates/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await dependencies.templates.delete(id);
    return reply.status(204).send();
  });
  app.post('/api/templates/import', async (request, reply) => {
    const upload = await collectMultipart(request, dependencies.paths);
    let template;
    try {
      assertOnlyFields(upload, ['name', 'layout'], ['background', 'thumbnail']);
      const name = parse(z.string().trim().min(1), upload.fields.name);
      const layout = upload.fields.layout === undefined
        ? undefined
        : parseJson(upload.fields.layout, 'Template layout JSON is invalid');
      template = await dependencies.templates.import({
        name,
        backgroundFile: requiredUpload(upload, 'background'),
        ...(upload.files.thumbnail ? { thumbnailFile: upload.files.thumbnail } : {}),
        ...(layout === undefined ? {} : { layout: layout as never }),
      });
    } finally {
      await upload.cleanup();
    }
    return reply.status(201).send(template);
  });

  app.get('/api/settings', async () => publicSettings(dependencies));
  app.put('/api/settings', async (request) => {
    const update = parse(SettingsUpdateSchema, request.body);
    if (update.googleApiKey === null) {
      await dependencies.secrets.clear('GOOGLE_TTS_API_KEY');
      await dependencies.refreshRedactionValues?.();
    }
    else if (update.googleApiKey !== undefined) {
      await dependencies.secrets.update({ GOOGLE_TTS_API_KEY: update.googleApiKey });
      await dependencies.refreshRedactionValues?.();
    }
    if (update.elevenlabsApiKey === null) {
      await dependencies.secrets.clear('ELEVENLABS_API_KEY');
      await dependencies.refreshRedactionValues?.();
    }
    else if (update.elevenlabsApiKey !== undefined) {
      await dependencies.secrets.update({ ELEVENLABS_API_KEY: update.elevenlabsApiKey });
      await dependencies.refreshRedactionValues?.();
    }
    dependencies.queue.updateSettings({
      ...(update.outputDirectory === undefined ? {} : { outputDirectory: update.outputDirectory }),
      ...(update.concurrency === undefined ? {} : { concurrency: update.concurrency }),
    });
    return publicSettings(dependencies);
  });

  app.post('/api/tts/credentials/validate', async (request) => {
    const body = parse(TtsCredentialValidationRequestSchema, request.body);
    return dependencies.providers[body.provider].validateCredentials(body);
  });
  app.get('/api/tts/voices', async (request) => {
    const query = parse(TtsListVoicesRequestSchema, request.query);
    return dependencies.providers[query.provider].listVoices(query);
  });
  app.post('/api/tts/preview', async (request, reply) => {
    const body = parse(TtsSynthesisRequestSchema, request.body);
    const baseRequest = createBaseSynthesisRequest({ ...body, audioFormat: 'mp3' });
    const previewDirectory = join(dependencies.paths.jobs, `preview-${randomUUID()}`);
    await mkdir(previewDirectory, { recursive: true });
    try {
      const entry = await dependencies.cache.getOrCreate(
        baseRequest,
        () => dependencies.providers[baseRequest.provider].synthesize(baseRequest),
      );
      const preparedPath = await prepareAudioAtSpeed(
        entry.absolutePath,
        join(previewDirectory, 'preview.wav'),
        body.speakingRate,
      );
      const bytes = await readManagedAudio(preparedPath);
      return reply
        .header('content-type', body.speakingRate === 1 ? entry.contentType : 'audio/wav')
        .send(bytes);
    } finally {
      await rm(previewDirectory, { recursive: true, force: true });
    }
  });

  app.get('/api/jobs', async () => ({ jobs: dependencies.queue.listJobs().map(publicJob) }));
  app.get('/api/jobs/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return publicJob(requireJob(dependencies.queue, id));
  });
  app.post('/api/jobs/enqueue', async (request, reply) => {
    const { projectIds } = parse(EnqueueSchema, request.body);
    const snapshots = await Promise.all(projectIds.map(async (projectId) => {
      const project = await dependencies.projects.get(projectId);
      const template = await dependencies.templates.get(project.templateId);
      return RenderJobSnapshotSchema.parse({ project, template });
    }));
    return reply.status(202).send({ jobs: dependencies.queue.enqueueBatch(snapshots).map(publicJob) });
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return publicJob(dependencies.queue.cancel(id));
  });
  app.post('/api/jobs/:id/retry', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return publicJob(dependencies.queue.retry(id));
  });

  app.get('/api/events', async (request, reply) => {
    const cursorHeader = request.headers['last-event-id'];
    const cursorValue = Array.isArray(cursorHeader) ? cursorHeader[0] : cursorHeader;
    let cursor = cursorValue === undefined ? 0 : Number(cursorValue);
    if (!Number.isInteger(cursor) || cursor < 0) throw invalidInput('Last-Event-ID is invalid');

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders();
    let closed = false;
    const sendAvailable = (): void => {
      if (closed) return;
      for (const event of dependencies.queue.readEvents(cursor)) {
        cursor = event.id;
        const type = event.type.replace(/[^a-zA-Z0-9_.-]/g, '-');
        reply.raw.write(
          `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify({
            ...(event.jobId ? { jobId: event.jobId } : {}),
            payload: event.payload,
            createdAt: event.createdAt,
          })}\n\n`,
        );
      }
    };
    sendAvailable();
    const poll = setInterval(sendAvailable, dependencies.eventPollIntervalMilliseconds ?? 250);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': heartbeat\n\n');
    }, dependencies.heartbeatMilliseconds ?? 15_000);
    poll.unref();
    heartbeat.unref();
    const cleanup = (closeResponse = false): void => {
      if (closeResponse && !reply.raw.writableEnded) reply.raw.end();
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      sseCleanups.delete(cleanup);
    };
    sseCleanups.add(cleanup);
    request.raw.once('close', cleanup);
  });

  app.post('/api/system/open-output-directory', async (_request, reply) => {
    await dependencies.openOutputDirectory(dependencies.queue.getSettings().outputDirectory);
    return reply.status(204).send();
  });

  const staticDirectory = dependencies.staticDirectory ?? dependencies.webRoot;
  if (staticDirectory) {
    app.setNotFoundHandler(async (request, reply) => serveStaticRequest(
      request.raw.url ?? request.url,
      staticDirectory,
      reply,
      Array.isArray(request.headers.range) ? request.headers.range[0] : request.headers.range,
    ));
  }

  app.addHook('preClose', async () => {
    for (const cleanup of [...sseCleanups]) cleanup(true);
  });

  app.addHook('onClose', async () => {
    for (const cleanup of [...sseCleanups]) cleanup(true);
  });

  return app;
}

export function resolveServerHost(host: string | undefined): '127.0.0.1' {
  if (host === undefined || host === '' || host === '127.0.0.1') return '127.0.0.1';
  throw new Error('ReelForge must bind to 127.0.0.1 loopback only');
}

export async function startServer(
  app: FastifyInstance,
  port = 3000,
  host?: string,
): Promise<string> {
  return app.listen({ host: resolveServerHost(host), port });
}

async function serveStaticRequest(
  url: string,
  directory: string,
  reply: FastifyReply,
  rangeHeader?: string,
) {
  const rawPath = url.split('?', 1)[0] ?? '/';
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return reply.status(400).send(createErrorPayload('INVALID_INPUT', 'Static path is invalid'));
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return reply.status(404).send(createErrorPayload('NOT_FOUND', 'API route was not found'));
  }
  const segments = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (
    pathname.startsWith('/api/')
    || pathname.includes(String.fromCharCode(0))
    || pathname.includes('\\')
    || segments.some((segment) => segment === '..' || segment === '.' || segment.startsWith('.'))
    || pathname.toLowerCase().endsWith('.map')
  ) {
    return reply.status(404).send(createErrorPayload('NOT_FOUND', 'Static asset was not found'));
  }

  const wantsAsset = extname(pathname) !== '';
  const requestedRelative = pathname === '/' || !wantsAsset ? 'index.html' : segments.join('/');
  let root: string;
  try {
    root = await realpath(directory);
  } catch {
    return reply.status(500).send(createErrorPayload('INTERNAL', 'Built web application is unavailable'));
  }
  const target = resolve(root, requestedRelative);
  const escaped = relative(root, target);
  if (
    escaped === '..'
    || escaped.startsWith(`..${sep}`)
    || escaped.startsWith('../')
    || escaped.startsWith('..\\')
    || resolve(target) === resolve(root)
  ) {
    return reply.status(404).send(createErrorPayload('NOT_FOUND', 'Static asset was not found'));
  }

  let information: Awaited<ReturnType<typeof stat>> | undefined;
  let servedPath: string;
  try {
    information = await stat(target);
    if (!information.isFile()) throw new Error('not a file');
    servedPath = await realpath(target);
    const servedRelative = relative(root, servedPath);
    if (
      servedRelative === '..'
      || servedRelative.startsWith(`..${sep}`)
      || servedRelative.startsWith('../')
      || servedRelative.startsWith('..\\')
      || servedRelative.split(/[\\/]/).some((segment) => segment.startsWith('.'))
    ) throw new Error('static file escaped root');
  } catch {
    if (!wantsAsset) {
      return reply.status(500).send(createErrorPayload('INTERNAL', 'Built web application is unavailable'));
    }
    return reply.status(404).send(createErrorPayload('NOT_FOUND', 'Static asset was not found'));
  }

  if (!information) {
    return reply.status(404).send(createErrorPayload('NOT_FOUND', 'Static asset was not found'));
  }
  const extension = extname(servedPath).toLowerCase();
  const contentType = staticContentType(extension);
  if (!contentType) return reply.status(404).send(createErrorPayload('NOT_FOUND', 'Static asset was not found'));
  const range = parseByteRange(rangeHeader, information.size);
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': requestedRelative === 'index.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  };
  if (range === 'unsatisfiable') {
    return reply
      .headers({ ...headers, 'content-range': `bytes */${information.size}` })
      .status(416)
      .send();
  }
  if (range) {
    return reply
      .headers({
        ...headers,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${information.size}`,
      })
      .status(206)
      .send(createReadStream(servedPath, { start: range.start, end: range.end }));
  }
  return reply
    .headers({ ...headers, 'content-length': String(information.size) })
    .send(createReadStream(servedPath));
}

function staticContentType(extension: string): string | undefined {
  switch (extension) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return undefined;
  }
}

async function publicSettings(dependencies: ServerDependencies) {
  const settings = dependencies.queue.getSettings();
  return dependencies.secrets.publicStatus(settings.outputDirectory, settings.concurrency);
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw invalidInput('Request validation failed');
  }
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidInput(message);
  }
}

interface CollectedMultipart {
  readonly directory: string;
  readonly fields: Record<string, string>;
  readonly files: Record<string, string>;
  cleanup(): Promise<void>;
}

async function collectMultipart(request: FastifyRequest, paths: AppPaths): Promise<CollectedMultipart> {
  if (!request.isMultipart()) throw invalidInput('Multipart form data is required');
  const directory = join(paths.data, 'uploads', randomUUID());
  const fields: Record<string, string> = {};
  const files: Record<string, string> = {};
  await mkdir(directory, { recursive: true });
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (files[part.fieldname]) throw invalidInput('Multipart file fields may not repeat');
        const extension = extname(safeFilename(part.filename || 'upload'));
        const target = join(directory, `${randomUUID()}${extension}`);
        await pipeline(part.file, createWriteStream(target, { flags: 'wx' }));
        if (part.file.truncated) throw invalidInput('Uploaded file is too large');
        files[part.fieldname] = target;
      } else {
        if (fields[part.fieldname] !== undefined) throw invalidInput('Multipart fields may not repeat');
        fields[part.fieldname] = String(part.value);
      }
    }
    return {
      directory,
      fields,
      files,
      cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertOnlyFields(
  upload: CollectedMultipart,
  fieldNames: readonly string[],
  fileNames: readonly string[],
): void {
  if (
    Object.keys(upload.fields).some((name) => !fieldNames.includes(name))
    || Object.keys(upload.files).some((name) => !fileNames.includes(name))
  ) {
    throw invalidInput('Multipart form contains unsupported fields');
  }
}

function requiredUpload(upload: CollectedMultipart, name: string): string {
  const path = upload.files[name];
  if (!path) throw invalidInput(`Multipart file ${name} is required`);
  return path;
}

function requireJob(queue: QueueStore, id: string) {
  const job = queue.getJob(id);
  if (!job) throw new ReelForgeError(createErrorPayload('NOT_FOUND', 'Job was not found'));
  return job;
}

function publicJob<T extends {
  readonly outputPath?: string;
  readonly cancelRequested?: boolean;
  readonly cleanupPendingPaths?: readonly string[];
}>(job: T) {
  const {
    outputPath: _outputPath,
    cancelRequested: _cancelRequested,
    cleanupPendingPaths: _cleanupPendingPaths,
    ...safeJob
  } = job;
  return RenderJobSchema.parse(safeJob);
}

async function readManagedAudio(path: string): Promise<Buffer> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path);
  } catch {
    throw new ReelForgeError(createErrorPayload('INTERNAL', 'Preview audio could not be read'));
  }
}

function invalidInput(message: string): ReelForgeError {
  return new ReelForgeError(createErrorPayload('INVALID_INPUT', message));
}

function parseByteRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size === 0) return 'unsatisfiable';
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) return 'unsatisfiable';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function assetContentType(filename: string): string {
  const extension = extname(filename).toLowerCase();
  switch (extension) {
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp3': return 'audio/mpeg';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mp4': return 'video/mp4';
    default: throw invalidInput('Asset filename is invalid');
  }
}

function publicError(error: unknown, sensitiveValues: readonly string[]): {
  status: number;
  payload: StructuredErrorPayload;
} {
  if (error instanceof ReelForgeError) {
    const payload = sanitizeErrorPayload(error.payload, sensitiveValues);
    return { status: statusFor(payload.code), payload };
  }
  if (
    error instanceof ZodError
    || (isRecord(error) && (
      'validation' in error
      || (typeof error.code === 'string' && error.code.startsWith('FST_ERR_'))
    ))
  ) {
    return { status: 400, payload: createErrorPayload('INVALID_INPUT', 'Request validation failed') };
  }
  return { status: 500, payload: createErrorPayload('INTERNAL', 'Request could not be completed') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeErrorPayload(
  payload: StructuredErrorPayload,
  sensitiveValues: readonly string[],
): StructuredErrorPayload {
  return createErrorPayload(
    payload.code,
    redactSensitiveText(payload.message, sensitiveValues),
    payload.details ? sanitizeDetails(payload.details, sensitiveValues) as Record<string, unknown> : undefined,
  );
}

function sanitizeDetails(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') return redactSensitiveText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeDetails(item, sensitiveValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:api.?key|authorization|password|secret|token)/i.test(key)
        ? '[REDACTED]'
        : sanitizeDetails(item, sensitiveValues),
    ]));
  }
  return value;
}

function statusFor(code: StructuredErrorPayload['code']): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'UNSUPPORTED_SCHEMA_VERSION':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'PROVIDER_UNAVAILABLE':
      return 503;
    case 'CANCELLED':
      return 409;
    case 'RENDER_FAILED':
    case 'INTERNAL':
      return 500;
  }
}
