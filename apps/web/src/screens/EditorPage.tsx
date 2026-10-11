import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { PostCardMeme, Project, ProjectCard, TemplateManifest, TtsProviderId } from '@reelforge/core';
import { CardMemeEditor } from '../components/CardMemeEditor';
import { ErrorNotice, LoadingBlock } from '../components/Feedback';
import { MediaLayoutEditor } from '../components/MediaLayoutEditor';
import { ResourcePicker } from '../components/ResourcePicker';
import { ApiError, assetUrl } from '../lib/api';
import { createAutosave, type AutosaveController, type AutosaveStatus } from '../lib/autosave';
import { getSlotStyle, type NormalizedRect, type PreviewCanvas } from '../lib/preview';
import { normalizeCardOrder, moveCard } from '../lib/reorder';
import { useApi } from '../app/api-context';
import { queryKeys, useProject, useResources, useTemplate, useTemplates, useVoices } from '../app/query-hooks';
import styles from './EditorPage.module.css';

const TTS_NOT_READY_MESSAGE = 'Voice TTS chưa sẵn sàng. Hãy chờ tải voice xong hoặc kiểm tra cấu hình TTS.';

export function EditorPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useProject(id);
  const templatesQuery = useTemplates();
  const [project, setProject] = useState<Project>();
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>('idle');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [audioUrl, setAudioUrl] = useState<string>();
  const [previewMode, setPreviewMode] = useState<'card' | 'meme'>('card');
  const [importing, setImporting] = useState(false);
  const dirtyRef = useRef(false);
  const autosaveRef = useRef<AutosaveController<Project> | undefined>(undefined);

  useEffect(() => {
    const controller = createAutosave<Project>({
      delayMs: 650,
      save: async (value) => { await api.saveProject(value); },
      onStatusChange: (status, reason) => {
        setSaveStatus(status);
        if (status === 'error') setError(getErrorMessage(reason, 'Không thể tự lưu project.'));
      },
    });
    autosaveRef.current = controller;

    return () => {
      controller.dispose();
      if (autosaveRef.current === controller) {
        autosaveRef.current = undefined;
      }
    };
  }, [api]);
  useEffect(() => {
    if (projectQuery.data && (!project || project.id !== projectQuery.data.id || !dirtyRef.current)) {
      setProject(projectQuery.data);
      setActiveCardIndex((index) => Math.min(index, Math.max(0, projectQuery.data.cards.length - 1)));
      dirtyRef.current = false;
      setSaveStatus('saved');
    }
  }, [project, projectQuery.data]);

  const template = useTemplate(project?.templateId).data;
  const allTemplates = templatesQuery.data ?? [];
  const resourcesQuery = useResources();
  const resources = resourcesQuery.data ?? [];
  const provider = project?.tts.provider ?? 'google';
  const hasNarration = project?.cards.some((card) => card.script.trim()) ?? false;
  const voicesQuery = useVoices(provider, hasNarration);
  const ttsReady = !hasNarration || (voicesQuery.isSuccess && Boolean(voicesQuery.data?.some((voice) => voice.id === project?.tts.voiceId)));
  const activeCard = project?.cards[activeCardIndex];

  useEffect(() => {
    const voices = voicesQuery.data;
    const firstVoice = voices?.[0];
    if (!project || !hasNarration || !firstVoice || voices.some((voice) => voice.id === project.tts.voiceId)) return;
    const next = { ...project, tts: { ...project.tts, voiceId: firstVoice.id } };
    dirtyRef.current = true;
    setProject(next);
    autosaveRef.current?.update(next);
  }, [hasNarration, project, voicesQuery.data]);

  const updateProject = (next: Project) => {
    dirtyRef.current = true;
    setProject(next);
    autosaveRef.current?.update(next);
  };
  const updateCard = (cardId: string, update: (card: ProjectCard) => ProjectCard) => {
    if (!project) return;
    updateProject({ ...project, cards: normalizeCardOrder(project.cards.map((card) => card.id === cardId ? update(card) : card)) });
  };
  const updateCardLayout = (layout: NormalizedRect) => {
    if (!activeCard) return;
    updateCard(activeCard.id, (card) => ({ ...card, layout }));
  };
  const resetCardLayout = () => {
    if (!activeCard) return;
    updateCard(activeCard.id, (card) => {
      const { layout: _layout, ...withoutLayout } = card;
      return withoutLayout;
    });
  };
  const updateMemeLayout = (layout: NormalizedRect) => {
    if (!activeCard?.postCardMeme) return;
    updateCard(activeCard.id, (card) => ({
      ...card,
      postCardMeme: { ...card.postCardMeme!, layout },
    }));
  };
  const resetMemeLayout = () => {
    if (!activeCard?.postCardMeme) return;
    updateCard(activeCard.id, (card) => {
      const meme = card.postCardMeme!;
      const { layout: _layout, ...withoutLayout } = meme;
      return { ...card, postCardMeme: withoutLayout };
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error('Project chưa tải xong');
      await autosaveRef.current?.flush();
      return project;
    },
    onSuccess: async () => {
      dirtyRef.current = false;
      setSaveStatus('saved');
      setNotice('Đã lưu phiên bản project hiện tại.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể lưu project.')),
  });

  const enqueueMutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error('Project chưa tải xong');
      if (hasNarration && !ttsReady) throw new Error(TTS_NOT_READY_MESSAGE);
      const invalid = project.cards.length === 0 || project.cards.some((card) => !isCardRenderable(card));
      if (invalid) throw new Error('Mỗi card cần có script hoặc thời gian giữ hợp lệ trước khi render.');
      await autosaveRef.current?.flush();
      dirtyRef.current = false;
      return api.enqueueProjects([project.id]);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      navigate('/queue');
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể đưa project vào queue.')),
  });

  const previewMutation = useMutation({
    mutationFn: async (card: ProjectCard) => {
      if (!project) throw new Error('Project chưa tải xong');
      if (hasNarration && !ttsReady) throw new Error(TTS_NOT_READY_MESSAGE);
      return api.previewTts({ provider: project.tts.provider, voiceId: project.tts.voiceId, modelId: project.tts.modelId, text: card.script, speakingRate: project.tts.speakingRate });
    },
    onSuccess: (blob) => {
      if (typeof URL.createObjectURL === 'function') {
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(blob));
      }
      setNotice('Đã tạo audio preview cho card.');
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể preview voice.')),
  });

  const importCards = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!id || !event.target.files?.length) return;
    setImporting(true);
    setError(undefined);
    try {
      for (const file of Array.from(event.target.files)) {
        const card = await api.importCard(id, file, '');
        setProject((current) => {
          if (!current) return current;
          const cards = normalizeCardOrder([...current.cards, card]);
          dirtyRef.current = true;
          autosaveRef.current?.update({ ...current, cards });
          return { ...current, cards };
        });
      }
      setNotice('Đã thêm card. Card trống sẽ giữ 3 giây; bạn có thể viết script hoặc chỉnh thời gian.');
    } catch (reason) {
      setError(getErrorMessage(reason, 'Không thể import ảnh card.'));
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  };

  const selectProvider = (nextProvider: TtsProviderId) => {
    if (!project || project.tts.provider === nextProvider) return;
    const { modelId: _oldProviderModel, ...tts } = project.tts;
    updateProject({ ...project, tts: { ...tts, provider: nextProvider, voiceId: '' } });
  };
  const handleTemplateChange = (templateId: string) => {
    if (!project) return;
    const nextTemplate = allTemplates.find((item) => item.id === templateId);
    if (!nextTemplate) return;
    updateProject({ ...project, templateId });
  };
  const updateTransitionSound = (path: string | undefined) => {
    if (!project) return;
    if (path) updateProject({ ...project, transitionSoundPath: path });
    else {
      const { transitionSoundPath: _transitionSoundPath, ...withoutTransition } = project;
      updateProject(withoutTransition);
    }
  };
  const updateIntroSound = (path: string | undefined) => {
    if (!project) return;
    if (path) updateProject({ ...project, introSoundPath: path });
    else {
      const { introSoundPath: _introSoundPath, ...withoutIntro } = project;
      updateProject(withoutIntro);
    }
  };
  const updateBackgroundMusic = (path: string | undefined) => {
    if (!project) return;
    if (path) updateProject({ ...project, backgroundMusicPath: path });
    else {
      const { backgroundMusicPath: _backgroundMusicPath, ...withoutMusic } = project;
      updateProject(withoutMusic);
    }
  };
  const canvas: PreviewCanvas = template ? { ...template.canvas, width: 360, height: 640 } : { width: 360, height: 640, fps: 30 };
  const previewCardLayout = activeCard?.layout;
  const previewMemeLayout = activeCard?.postCardMeme?.layout;
  const previewCardStyle = template ? getSlotStyle(previewCardLayout ?? template.cardSlot, canvas) : {};
  const previewMemeStyle = template ? getSlotStyle(previewMemeLayout ?? template.memeSlot, canvas) : {};

  if (projectQuery.isError) return <ErrorNotice message="Không thể mở project này." />;
  if (projectQuery.isLoading || !project) return <LoadingBlock label="Đang mở project…" />;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <button className={styles.backButton} type="button" onClick={() => navigate('/projects')}>← Projects</button>
          <p className={styles.kicker}>EDITOR / {project.id.slice(0, 8)}</p>
          <h1>Biên tập project</h1>
          <p className={styles.subtitle}>Sắp xếp card, viết narration và nhìn đúng composition 9:16 trước khi render.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.saveState} ${saveStatus === 'error' ? styles.saveError : ''}`} role="status">
            <span className={styles.saveDot} aria-hidden="true" />{saveStatus === 'saving' ? 'Đang lưu…' : saveStatus === 'scheduled' ? 'Chờ tự lưu…' : saveStatus === 'error' ? 'Lưu lỗi — thử lại' : 'Đã lưu'}
          </span>
          <button className={styles.ghostButton} type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || enqueueMutation.isPending}>{saveMutation.isPending ? 'Đang lưu…' : 'Lưu project'}</button>
          <button className={styles.primaryButton} type="button" onClick={() => enqueueMutation.mutate()} disabled={enqueueMutation.isPending || saveMutation.isPending || !ttsReady}>{enqueueMutation.isPending ? 'Đang xếp…' : 'Đưa vào hàng đợi'}</button>
        </div>
      </header>
      {error && <ErrorNotice message={error} />}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <div className={styles.editorGrid}>
        <section className={styles.workflow} aria-label="Workflow card và script">
          <div className={styles.panel}>
            <div className={styles.panelHeader}><div><p className={styles.panelKicker}>01 / PROJECT SETUP</p><h2>Thông tin project</h2></div><span className={styles.panelCode}>V2</span></div>
            <div className={styles.formGrid}>
              <Field label="Tên project" htmlFor="project-name"><input id="project-name" value={project.name} onChange={(event) => updateProject({ ...project, name: event.target.value })} /></Field>
              <Field label="Template" htmlFor="project-template"><select id="project-template" value={project.templateId} onChange={(event) => handleTemplateChange(event.target.value)}>{allTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Provider" htmlFor="project-provider"><select id="project-provider" value={project.tts.provider} onChange={(event) => selectProvider(event.target.value as TtsProviderId)}><option value="google">Google Cloud</option><option value="elevenlabs">ElevenLabs</option></select></Field>
              <Field label="Voice" htmlFor="project-voice"><select id="project-voice" value={project.tts.voiceId} onChange={(event) => updateProject({ ...project, tts: { ...project.tts, voiceId: event.target.value } })} disabled={!hasNarration || voicesQuery.isLoading}>{hasNarration ? voicesQuery.isLoading ? <option value={project.tts.voiceId}>Đang tải voice…</option> : voicesQuery.data?.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.languageCode}</option>) : <option value={project.tts.voiceId}>Không cần voice khi mọi card trống</option>}</select></Field>
              <Field label="Model (tuỳ chọn)" htmlFor="project-model"><input id="project-model" value={project.tts.modelId ?? ''} placeholder="Provider mặc định" onChange={(event) => updateProject({ ...project, tts: { ...project.tts, ...(event.target.value ? { modelId: event.target.value } : { modelId: undefined }) } })} /></Field>
              <Field label="Tốc độ đọc" htmlFor="project-speed"><div className={styles.rangeRow}><input id="project-speed" type="range" min="0.5" max="2" step="0.05" value={project.tts.speakingRate} onChange={(event) => updateProject({ ...project, tts: { ...project.tts, speakingRate: Number(event.target.value) } })} /><output htmlFor="project-speed">{project.tts.speakingRate.toFixed(2)}×</output></div></Field>
              <div className={styles.audioSelectors}>
                <ResourcePicker label="Transition sound toàn project" kind="transition-sound" value={project.transitionSoundPath} resources={resources} onChange={updateTransitionSound} />
                <ResourcePicker label="Intro sound" kind="intro-sound" value={project.introSoundPath} resources={resources} onChange={updateIntroSound} />
                <ResourcePicker label="Nhạc nền" kind="background-music" value={project.backgroundMusicPath} resources={resources} onChange={updateBackgroundMusic} />
                <p className={styles.audioHint}>Intro phát cùng card đầu tiên. Transition dùng cho các card tiếp theo; nhạc nền được renderer tự giảm khi có giọng đọc.</p>
              </div>
            </div>
            <p className={styles.speedHint}>Tốc độ 0.5×–2× được xử lý local bằng FFmpeg, dùng được với mọi model.</p>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}><div><p className={styles.panelKicker}>02 / CARD SCRIPT WORKFLOW</p><h2>Cards & narration <span>{project.cards.length}</span></h2></div><label className={styles.uploadButton}><input aria-label="Thêm ảnh card" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={importCards} disabled={importing} />{importing ? 'Đang import…' : '+ Thêm ảnh'}</label></div>
            <p className={styles.panelHint}>Ảnh được quản lý bởi server local. Card có script sẽ dùng TTS; card trống dùng thời gian giữ từ 1 đến 5 giây.</p>
            {project.cards.length === 0 ? <div className={styles.cardEmpty}><span aria-hidden="true">▧</span><strong>Chưa có card</strong><p>Thêm PNG, JPEG hoặc WebP hoàn chỉnh để bắt đầu.</p></div> : <div className={styles.cardList}>{project.cards.map((card, index) => <CardRow key={card.id} card={card} index={index} total={project.cards.length} active={index === activeCardIndex} resources={resources} isFinal={index === project.cards.length - 1} ttsReady={ttsReady} onSelect={() => setActiveCardIndex(index)} onChange={(script) => updateCard(card.id, (current) => ({ ...current, script }))} onHoldChange={(holdSeconds) => updateCard(card.id, (current) => ({ ...current, holdSeconds }))} onApplyMeme={(meme) => updateCard(card.id, (current) => ({ ...current, postCardMeme: meme }))} onClearMeme={() => updateCard(card.id, (current) => { const { postCardMeme: _postCardMeme, ...withoutMeme } = current; return withoutMeme; })} onMove={(direction) => { const cards = moveCard(project.cards, index, direction); updateProject({ ...project, cards }); setActiveCardIndex(direction === 'up' ? index - 1 : index + 1); }} onDelete={() => { const cards = normalizeCardOrder(project.cards.filter((item) => item.id !== card.id)); updateProject({ ...project, cards }); setActiveCardIndex(Math.min(activeCardIndex, Math.max(0, cards.length - 1))); }} onPreview={() => previewMutation.mutate(card)} previewing={previewMutation.isPending && previewMutation.variables?.id === card.id} />)}</div>}
          </div>
        </section>
        <aside className={styles.previewColumn} aria-label="Preview 9:16">
          <div className={styles.previewPanel}>
            <div className={styles.panelHeader}><div><p className={styles.panelKicker}>LIVE COMPOSITION</p><h2>Preview <span>720 × 1280</span></h2></div><span className={styles.liveBadge}><span aria-hidden="true" />LIVE</span></div>
            <div className={styles.previewToggle} role="group" aria-label="Chế độ preview"><button type="button" className={previewMode === 'card' ? styles.previewToggleActive : ''} onClick={() => setPreviewMode('card')}>Card</button><button type="button" className={previewMode === 'meme' ? styles.previewToggleActive : ''} onClick={() => setPreviewMode('meme')}>Meme sau card</button></div>
            <PreviewFrame template={template} card={activeCard} totalCards={project.cards.length} canvas={canvas} cardStyle={previewCardStyle} memeStyle={previewMemeStyle} mode={previewMode} onSelectCard={setActiveCardIndex} activeCardIndex={activeCardIndex} cardLayout={previewCardLayout} memeLayout={previewMemeLayout} onCardLayoutChange={updateCardLayout} onCardLayoutReset={resetCardLayout} onMemeLayoutChange={updateMemeLayout} onMemeLayoutReset={resetMemeLayout} />
            <div className={styles.previewMeta}><span>Card {project.cards.length ? activeCardIndex + 1 : 0} / {project.cards.length}</span><span>Audio renderer-owned</span></div>
            {audioUrl && <audio controls src={audioUrl} aria-label="Audio preview" />}
          </div>
          <div className={styles.previewNote}><span className={styles.noteIcon} aria-hidden="true">◈</span><div><strong>Geometry từ manifest</strong><p>Card dùng contain trong slot chuẩn. Gameplay cover + loop + muted; renderer giữ timing narration.</p></div></div>
        </aside>
      </div>
    </div>
  );
}

function CardRow({ card, index, total, active, resources, isFinal, ttsReady, onSelect, onChange, onHoldChange, onApplyMeme, onClearMeme, onMove, onDelete, onPreview, previewing }: {
  readonly card: ProjectCard; readonly index: number; readonly total: number; readonly active: boolean; readonly resources: readonly import('@reelforge/core').MediaResourceV1[]; readonly isFinal: boolean; readonly ttsReady: boolean; readonly onSelect: () => void; readonly onChange: (script: string) => void; readonly onHoldChange: (holdSeconds: number) => void; readonly onApplyMeme: (meme: PostCardMeme) => void; readonly onClearMeme: () => void; readonly onMove: (direction: 'up' | 'down') => void; readonly onDelete: () => void; readonly onPreview: () => void; readonly previewing: boolean;
}) {
  const isPlaceholder = card.script.startsWith('⚠');
  const isBlank = !card.script.trim();
  const holdSeconds = card.holdSeconds ?? 3;
  return (
    <article className={`${styles.cardRow} ${active ? styles.cardRowActive : ''}`}>
      <button type="button" className={styles.cardSelect} aria-label={`Chọn card ${index + 1}`} onClick={onSelect}><span className={styles.cardNumber}>{String(index + 1).padStart(2, '0')}</span><img src={assetUrl(card.imagePath)} alt={`Card ${index + 1}`} /></button>
      <div className={styles.cardEditor}><div className={styles.cardRowHead}><span className={styles.dragHandle} aria-hidden="true">⠿</span><strong>Card {index + 1}</strong><span className={styles.charCount}>{card.script.length} ký tự</span></div><label className={styles.srOnly} htmlFor={`script-${card.id}`}>Script card {index + 1}</label><textarea id={`script-${card.id}`} aria-label={`Script card ${index + 1}`} className={isPlaceholder ? styles.placeholderScript : ''} value={card.script} onChange={(event) => onChange(event.target.value)} rows={3} />{isBlank && <label className={styles.field} htmlFor={`hold-${card.id}`}><span>Thời gian giữ card {index + 1}</span><div className={styles.rangeRow}><input id={`hold-${card.id}`} aria-label={`Thời gian giữ card ${index + 1}`} type="range" min="1" max="5" step="1" value={holdSeconds} onChange={(event) => onHoldChange(Number(event.target.value))} /><output htmlFor={`hold-${card.id}`}>{holdSeconds}s</output></div></label>}<div className={styles.cardRowActions}><button type="button" onClick={onPreview} disabled={isBlank || !ttsReady || previewing}>{previewing ? 'Đang tạo…' : `Nghe thử script card ${index + 1}`}</button><button type="button" onClick={() => onMove('up')} disabled={index === 0} aria-label={`Đưa card ${index + 1} lên`}>↑</button><button type="button" onClick={() => onMove('down')} disabled={index === total - 1} aria-label={`Đưa card ${index + 1} xuống`}>↓</button><button type="button" onClick={onDelete} aria-label={`Xoá card ${index + 1}`}>Xoá</button></div><CardMemeEditor value={card.postCardMeme} resources={resources} isFinal={isFinal} onApply={onApplyMeme} onClear={onClearMeme} /></div>
    </article>
  );
}

function PreviewFrame({ template, card, totalCards, canvas, cardStyle, memeStyle, mode, onSelectCard, activeCardIndex, cardLayout, memeLayout, onCardLayoutChange, onCardLayoutReset, onMemeLayoutChange, onMemeLayoutReset }: {
  readonly template?: TemplateManifest; readonly card?: ProjectCard; readonly totalCards: number; readonly canvas: PreviewCanvas; readonly cardStyle: Record<string, string>; readonly memeStyle: Record<string, string>; readonly mode: 'card' | 'meme'; readonly onSelectCard: (index: number) => void; readonly activeCardIndex: number; readonly cardLayout?: NormalizedRect; readonly memeLayout?: NormalizedRect; readonly onCardLayoutChange: (layout: NormalizedRect) => void; readonly onCardLayoutReset: () => void; readonly onMemeLayoutChange: (layout: NormalizedRect) => void; readonly onMemeLayoutReset: () => void;
}) {
  const meme = card?.postCardMeme;
  return (
    <div className={styles.previewFrame}>
      {template ? <video className={styles.previewGameplay} src={assetUrl(template.backgroundPath)} muted loop playsInline autoPlay aria-label="Gameplay preview" /> : <div className={styles.previewPlaceholder}>Chọn template để xem preview</div>}
      <div className={styles.previewShade} />
      {card ? mode === 'card' && template ? <MediaLayoutEditor kind="image" src={assetUrl(card.imagePath)} accessibleName={`Preview card ${activeCardIndex + 1}`} value={cardLayout} templateSlot={template.cardSlot} canvas={canvas} onChange={onCardLayoutChange} onReset={onCardLayoutReset} /> : <img className={styles.previewCard} src={assetUrl(card.imagePath)} alt={`Preview card ${activeCardIndex + 1}`} style={cardStyle} /> : <div className={styles.previewCardEmpty}>Thêm card để xem composition</div>}
      {mode === 'meme' && meme && (template ? <MediaLayoutEditor kind={'videoPath' in meme ? 'video' : 'image'} src={assetUrl('videoPath' in meme ? meme.videoPath : meme.imagePath)} accessibleName={`Meme ${'videoPath' in meme ? 'video' : 'image'} sau card ${activeCardIndex + 1}`} value={memeLayout} templateSlot={template.memeSlot} canvas={canvas} videoControls={'videoPath' in meme} onChange={onMemeLayoutChange} onReset={onMemeLayoutReset} /> : 'videoPath' in meme ? <video className={styles.previewMeme} data-testid="preview-meme" src={assetUrl(meme.videoPath)} controls playsInline aria-label={`Meme video sau card ${activeCardIndex + 1}`} style={memeStyle} /> : <img className={styles.previewMeme} data-testid="preview-meme" src={assetUrl(meme.imagePath)} alt={`Meme sau card ${activeCardIndex + 1}`} style={memeStyle} />)}
      <div className={styles.previewSelector} aria-label="Chọn card preview">{Array.from({ length: Math.max(1, totalCards) }, (_, index) => <button key={index} type="button" className={index === activeCardIndex ? styles.previewSelectorActive : ''} aria-label={`Preview card ${index + 1}`} onClick={() => onSelectCard(index)}>{String(index + 1).padStart(2, '0')}</button>)}</div>
      <span className={styles.previewWatermark}>REELFORGE</span>
    </div>
  );
}

function Field({ label, htmlFor, children }: { readonly label: string; readonly htmlFor: string; readonly children: ReactNode }) {
  return <label className={styles.field} htmlFor={htmlFor}><span>{label}</span>{children}</label>;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

function isCardRenderable(card: ProjectCard): boolean {
  if (card.script.trim()) return !card.script.startsWith('⚠');
  const holdSeconds = card.holdSeconds ?? 3;
  return Number.isFinite(holdSeconds) && holdSeconds >= 1 && holdSeconds <= 5;
}
