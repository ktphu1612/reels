import { z } from 'zod';

export const TtsProviderIdSchema = z.enum(['google', 'elevenlabs']);
export type TtsProviderId = z.infer<typeof TtsProviderIdSchema>;

export const NormalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((rectangle) => rectangle.x + rectangle.width <= 1, {
    message: 'Rectangle must fit within the normalized horizontal bounds',
  })
  .refine((rectangle) => rectangle.y + rectangle.height <= 1, {
    message: 'Rectangle must fit within the normalized vertical bounds',
  });
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

export const DEFAULT_OUTPUT = {
  width: 720,
  height: 1280,
  fps: 30,
  crf: 20,
} as const;

export const DEFAULT_CARD_SLOT = {
  x: 0.05,
  y: 0.38,
  width: 0.9,
  height: 0.25,
} as const;

export const DEFAULT_MEME_SLOT = {
  x: 0.3,
  y: 0.63,
  width: 0.4,
  height: 0.31,
} as const;

/** @deprecated Legacy v1 template manifests call this the sticker slot. */
export const DEFAULT_STICKER_SLOT = DEFAULT_MEME_SLOT;

export const OutputSettingsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    crf: z.number().int().min(0).max(51),
  })
  .strict();
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;

export const ProjectCardSchema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    script: z.string().min(1),
    order: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectCardV1 = z.infer<typeof ProjectCardSchema>;

export const ProjectTtsSettingsSchema = z
  .object({
    provider: TtsProviderIdSchema,
    voiceId: z.string().min(1),
    modelId: z.string().min(1).optional(),
    speakingRate: z.number().positive(),
  })
  .strict();
export type ProjectTtsSettings = z.infer<typeof ProjectTtsSettingsSchema>;

export const ProjectV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    templateId: z.string().min(1),
    tts: ProjectTtsSettingsSchema,
    output: OutputSettingsSchema.default(DEFAULT_OUTPUT),
    cards: z.array(ProjectCardSchema),
  })
  .strict();
export type ProjectV1 = z.infer<typeof ProjectV1Schema>;

const CardLayoutSchema = NormalizedRectSchema
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      context.addIssue({ code: 'custom', message: 'Card layout must fit inside the canvas' });
    }
  })
  .refine((rect) => rect.width >= 0.1, {
    message: 'Card layout width must be at least 0.1',
  })
  .refine((rect) => rect.height >= 0.1, {
    message: 'Card layout height must be at least 0.1',
  });

export const PostCardMemeSchema = z.union([
  z
    .object({
      imagePath: z.string().min(1),
      soundPath: z.string().min(1),
      layout: CardLayoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      videoPath: z.string().min(1),
      soundPath: z.string().min(1).optional(),
      layout: CardLayoutSchema.optional(),
    })
    .strict(),
]);
export type PostCardMeme = z.infer<typeof PostCardMemeSchema>;

export const ProjectCardV2Schema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    script: z.string(),
    order: z.number().int().nonnegative(),
    postCardMeme: PostCardMemeSchema.optional(),
    holdSeconds: z.number().min(1).max(5).optional(),
    layout: CardLayoutSchema.optional(),
  })
  .strict();
export type ProjectCardV2 = z.infer<typeof ProjectCardV2Schema>;

export const ProjectV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    name: z.string().min(1),
    templateId: z.string().min(1),
    tts: ProjectTtsSettingsSchema.extend({
      speakingRate: z.number().min(0.5).max(2),
    }).strict(),
    output: OutputSettingsSchema.default(DEFAULT_OUTPUT),
    transitionSoundPath: z.string().min(1).optional(),
    backgroundMusicPath: z.string().min(1).optional(),
    introSoundPath: z.string().min(1).optional(),
    cards: z.array(ProjectCardV2Schema),
  })
  .strict();
export type ProjectV2 = z.infer<typeof ProjectV2Schema>;
export const ProjectSchema = ProjectV2Schema;
export type Project = ProjectV2;
export type ProjectCard = ProjectCardV2;

export const TemplateCanvasSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  })
  .strict();
export type TemplateCanvas = z.infer<typeof TemplateCanvasSchema>;

export const TemplateManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    backgroundPath: z.string().min(1),
    thumbnailPath: z.string().min(1).optional(),
    stickerPath: z.string().min(1).optional(),
    canvas: TemplateCanvasSchema,
    cardSlot: NormalizedRectSchema.default(DEFAULT_CARD_SLOT),
    stickerSlot: NormalizedRectSchema.default(DEFAULT_STICKER_SLOT),
  })
  .strict();
export type TemplateManifestV1 = z.infer<typeof TemplateManifestV1Schema>;

export const TemplateManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    name: z.string().min(1),
    backgroundPath: z.string().min(1),
    thumbnailPath: z.string().min(1).optional(),
    canvas: TemplateCanvasSchema,
    cardSlot: NormalizedRectSchema.default(DEFAULT_CARD_SLOT),
    memeSlot: NormalizedRectSchema.default(DEFAULT_MEME_SLOT),
  })
  .strict();
export type TemplateManifestV2 = z.infer<typeof TemplateManifestV2Schema>;
export const TemplateManifestSchema = TemplateManifestV2Schema;
export type TemplateManifest = TemplateManifestV2;

export const MediaResourceKindSchema = z.enum([
  'meme-image',
  'meme-video',
  'meme-sound',
  'transition-sound',
  'intro-sound',
  'background-music',
]);
export type MediaResourceKind = z.infer<typeof MediaResourceKindSchema>;

export const MediaResourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    kind: MediaResourceKindSchema,
    assetPath: z.string().min(1),
  })
  .strict();
export type MediaResourceV1 = z.infer<typeof MediaResourceV1Schema>;

const ProviderPublicStatusSchema = z
  .object({
    ready: z.boolean(),
    maskedKey: z.string().min(1).optional(),
  })
  .strict();

export const SettingsPublicSchema = z
  .object({
    outputDirectory: z.string().min(1),
    concurrency: z.number().int().min(1).max(4).default(1),
    providers: z
      .object({
        google: ProviderPublicStatusSchema,
        elevenlabs: ProviderPublicStatusSchema,
      })
      .strict(),
  })
  .strict();
export type SettingsPublic = z.infer<typeof SettingsPublicSchema>;

export const TtsCredentialValidationRequestSchema = z
  .object({ provider: TtsProviderIdSchema })
  .strict();
export type TtsCredentialValidationRequest = z.infer<
  typeof TtsCredentialValidationRequestSchema
>;

export const TtsCredentialValidationResultSchema = z
  .object({
    ready: z.boolean(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type TtsCredentialValidationResult = z.infer<
  typeof TtsCredentialValidationResultSchema
>;

export const TtsVoiceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    languageCode: z.string().min(1),
  })
  .strict();
export type TtsVoice = z.infer<typeof TtsVoiceSchema>;

export const TtsListVoicesRequestSchema = z
  .object({
    provider: TtsProviderIdSchema,
    languageCode: z.string().min(1).optional(),
  })
  .strict();
export type TtsListVoicesRequest = z.infer<typeof TtsListVoicesRequestSchema>;

export const TtsListVoicesResultSchema = z
  .object({ voices: z.array(TtsVoiceSchema) })
  .strict();
export type TtsListVoicesResult = z.infer<typeof TtsListVoicesResultSchema>;

export const TtsSynthesisRequestSchema = z
  .object({
    provider: TtsProviderIdSchema,
    voiceId: z.string().min(1),
    modelId: z.string().min(1).optional(),
    text: z.string().min(1),
    speakingRate: z.number().positive(),
    audioFormat: z.enum(['mp3', 'wav']),
  })
  .strict();
export type TtsSynthesisRequest = z.infer<typeof TtsSynthesisRequestSchema>;

export const TtsSynthesisResultSchema = z
  .object({
    audioBase64: z.string().min(1),
    contentType: z.string().min(1),
  })
  .strict();
export type TtsSynthesisResult = z.infer<typeof TtsSynthesisResultSchema>;

export interface TtsSynthesisOptions {
  readonly signal?: AbortSignal;
}

export interface TtsProvider {
  validateCredentials(
    request: TtsCredentialValidationRequest,
  ): Promise<TtsCredentialValidationResult>;
  listVoices(request: TtsListVoicesRequest): Promise<TtsListVoicesResult>;
  synthesize(request: TtsSynthesisRequest, options?: TtsSynthesisOptions): Promise<TtsSynthesisResult>;
}

export const StructuredErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'UNSUPPORTED_SCHEMA_VERSION',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'PROVIDER_UNAVAILABLE',
  'RENDER_FAILED',
  'CANCELLED',
  'INTERNAL',
]);
export type StructuredErrorCode = z.infer<typeof StructuredErrorCodeSchema>;

export const StructuredErrorPayloadSchema = z
  .object({
    code: StructuredErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type StructuredErrorPayload = z.infer<typeof StructuredErrorPayloadSchema>;

export function createErrorPayload(
  code: StructuredErrorCode,
  message: string,
  details?: Record<string, unknown>,
): StructuredErrorPayload {
  return StructuredErrorPayloadSchema.parse({ code, message, details });
}

export class ReelForgeError extends Error {
  readonly payload: StructuredErrorPayload;

  constructor(payload: StructuredErrorPayload) {
    super(payload.message);
    this.name = 'ReelForgeError';
    this.payload = payload;
  }
}

export const RenderJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const RenderJobSnapshotV1Schema = z
  .object({
    project: ProjectV1Schema,
    template: TemplateManifestV1Schema,
  })
  .strict();
export type RenderJobSnapshotV1 = Readonly<z.infer<typeof RenderJobSnapshotV1Schema>>;

export const RenderJobSnapshotV2Schema = z
  .object({
    project: ProjectV2Schema,
    template: TemplateManifestV2Schema,
  })
  .strict();
export type RenderJobSnapshotV2 = Readonly<z.infer<typeof RenderJobSnapshotV2Schema>>;
export const RenderJobSnapshotSchema = RenderJobSnapshotV2Schema;
export type RenderJobSnapshot = RenderJobSnapshotV2;

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const RenderJobSchema = z.preprocess(
  normalizeRenderJobInput,
  z
    .object({
      id: z.string().min(1),
      status: RenderJobStatusSchema,
      snapshot: RenderJobSnapshotV2Schema,
      progress: z.number().min(0).max(100),
      attempts: z.number().int().nonnegative(),
      createdAt: IsoTimestampSchema,
      updatedAt: IsoTimestampSchema,
      startedAt: IsoTimestampSchema.optional(),
      completedAt: IsoTimestampSchema.optional(),
      outputPath: z.string().min(1).optional(),
      error: StructuredErrorPayloadSchema.optional(),
    })
    .strict(),
);
export type RenderJob = Omit<z.infer<typeof RenderJobSchema>, 'snapshot'> & {
  readonly snapshot: RenderJobSnapshot;
};

function unsupportedSchemaVersion(
  entity: 'project' | 'template manifest',
  input: unknown,
): ReelForgeError {
  const schemaVersion =
    typeof input === 'object' && input !== null && 'schemaVersion' in input
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const displayVersion = schemaVersion === undefined ? 'missing' : String(schemaVersion);

  return new ReelForgeError(
    createErrorPayload(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Unsupported ${entity} schema version: ${displayVersion}`,
      { schemaVersion },
    ),
  );
}

export function migrateProject(input: unknown): Project {
  if (!isRecord(input)) {
    throw unsupportedSchemaVersion('project', input);
  }

  if (input.schemaVersion === 1) {
    const legacy = ProjectV1Schema.parse(input);
    return ProjectV2Schema.parse({
      schemaVersion: 2,
      id: legacy.id,
      name: legacy.name,
      templateId: legacy.templateId,
      tts: {
        ...legacy.tts,
        speakingRate: Math.min(2, Math.max(0.5, legacy.tts.speakingRate)),
      },
      output: legacy.output,
      cards: legacy.cards.map((card) => ({
        id: card.id,
        imagePath: card.imagePath,
        script: card.script,
        order: card.order,
      })),
    });
  }

  if (input.schemaVersion === 2) {
    return ProjectV2Schema.parse(input);
  }

  throw unsupportedSchemaVersion('project', input);
}

export function parseProject(input: unknown): Project {
  return migrateProject(input);
}

export function migrateTemplateManifest(input: unknown): TemplateManifest {
  if (!isRecord(input)) {
    throw unsupportedSchemaVersion('template manifest', input);
  }

  if (input.schemaVersion === 1) {
    const legacy = TemplateManifestV1Schema.parse(input);
    return TemplateManifestV2Schema.parse({
      schemaVersion: 2,
      id: legacy.id,
      name: legacy.name,
      backgroundPath: legacy.backgroundPath,
      ...(legacy.thumbnailPath === undefined ? {} : { thumbnailPath: legacy.thumbnailPath }),
      canvas: legacy.canvas,
      cardSlot: legacy.cardSlot,
      memeSlot: legacy.stickerSlot,
    });
  }

  if (input.schemaVersion === 2) {
    return TemplateManifestV2Schema.parse(input);
  }

  throw unsupportedSchemaVersion('template manifest', input);
}

export function parseTemplateManifest(input: unknown): TemplateManifest {
  return migrateTemplateManifest(input);
}

function normalizeRenderJobInput(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.snapshot)) return input;

  return {
    ...input,
    snapshot: {
      project: migrateProject(input.snapshot.project),
      template: migrateTemplateManifest(input.snapshot.template),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function safeFilename(value: string, fallback = 'untitled'): string {
  return sanitizeFilename(value) ?? sanitizeFilename(fallback) ?? 'untitled';
}

function sanitizeFilename(value: string): string | undefined {
  const normalized = value.trim();
  const extensionIndex = normalized.lastIndexOf('.');
  const rawBase = extensionIndex > 0 ? normalized.slice(0, extensionIndex) : normalized;
  const rawExtension = extensionIndex > 0 ? normalized.slice(extensionIndex + 1) : '';
  const base = sanitizeFilenameSegment(rawBase).replace(/^\.+|\.+$/g, '');
  const extension = sanitizeFilenameSegment(rawExtension).replace(/[^a-zA-Z0-9]/g, '');
  if (!base) {
    return undefined;
  }

  const safeBase = ensureNonReservedFilename(base);
  const safeExtension = extension ? `.${extension.toLowerCase()}` : '';
  const maxBaseLength = Math.max(1, 120 - safeExtension.length);

  return `${safeBase.slice(0, maxBaseLength)}${safeExtension}`;
}

function sanitizeFilenameSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureNonReservedFilename(value: string): string {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
    ? `file-${value}`
    : value;
}
