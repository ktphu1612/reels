import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { Project, ProjectTtsSettings, TtsProviderId } from '@reelforge/core';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorNotice, LoadingBlock } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { ApiError, assetUrl } from '../lib/api';
import { batchEnqueuePayload, reconcileSelection } from '../lib/selection';
import { useApi } from '../app/api-context';
import { queryKeys, useProjects, useTemplates, useVoices } from '../app/query-hooks';
import styles from './ProjectsPage.module.css';

export const BLANK_ONLY_VOICE_ID = 'not-required-for-blank-cards';

export function ProjectsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  const templatesQuery = useTemplates();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project>();
  const [duplicateTarget, setDuplicateTarget] = useState<Project>();
  const [notice, setNotice] = useState<string>();

  const projects = projectsQuery.data ?? [];
  const templates = templatesQuery.data ?? [];
  const templateById = useMemo(() => new Map(templates.map((template) => [template.id, template])), [templates]);
  const filteredProjects = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('vi');
    return needle ? projects.filter((project) => project.name.toLocaleLowerCase('vi').includes(needle)) : projects;
  }, [projects, search]);
  const allFilteredSelected = filteredProjects.length > 0 && filteredProjects.every((project) => selected.has(project.id));

  useEffect(() => {
    if (projectsQuery.data) setSelected((current) => reconcileSelection(current, projectsQuery.data ?? []));
  }, [projectsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: async () => {
      setDeleteTarget(undefined);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
  const duplicateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.duplicateProject(id, name),
    onSuccess: async (project) => {
      setDuplicateTarget(undefined);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      navigate(`/projects/${project.id}`);
    },
  });
  const enqueueMutation = useMutation({
    mutationFn: (ids: string[]) => api.enqueueProjects(ids),
    onSuccess: async () => {
      setNotice('Đã đưa project vào queue.');
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      navigate('/queue');
    },
  });

  const toggleProject = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleFiltered = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filteredProjects.forEach((project) => next.delete(project.id));
      else filteredProjects.forEach((project) => next.add(project.id));
      return next;
    });
  };

  if (projectsQuery.isLoading || templatesQuery.isLoading) return <LoadingBlock label="Đang tải workspace…" />;
  if (projectsQuery.isError || templatesQuery.isError) return <ErrorNotice message="Không thể tải workspace. Hãy kiểm tra server local." />;

  const content = (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.kicker}>WORKSPACE / PROJECTS</p>
          <h1>Projects <span>{projects.length.toString().padStart(2, '0')}</span></h1>
          <p className={styles.subtitle}>Tập trung card, script và template trước khi đưa vào render.</p>
        </div>
        <div className={styles.headerActions}>
          <Link className={styles.ghostButton} to="/settings#templates">Import template</Link>
          <button className={styles.primaryButton} type="button" onClick={() => setCreateOpen(true)}>Tạo project</button>
        </div>
      </header>

      <section className={styles.toolbar} aria-label="Bộ lọc project">
        <label className={styles.searchField}>
          <span className={styles.srOnly}>Tìm project</span>
          <span aria-hidden="true">⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm theo tên project…" />
        </label>
        <div className={styles.selectionActions}>
          <label className={styles.selectAll}>
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleFiltered} aria-label="Chọn tất cả project đang hiển thị" />
            <span>Chọn tất cả</span>
          </label>
          <button
            type="button"
            className={styles.batchButton}
            disabled={selected.size === 0 || enqueueMutation.isPending}
            onClick={() => enqueueMutation.mutate(batchEnqueuePayload(selected).projectIds)}
          >
            {enqueueMutation.isPending ? 'Đang xếp…' : `Render batch${selected.size ? ` · ${selected.size}` : ''}`}
          </button>
        </div>
      </section>

      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {projects.length === 0 ? (
        <EmptyState
          title="Chưa có project nào"
          detail={templates.length === 0 ? 'Import một gameplay template trước, sau đó tạo project đầu tiên.' : 'Tạo project mới để bắt đầu với các card và script tiếng Việt.'}
          action={templates.length === 0 ? <Link className={styles.primaryButton} to="/settings#templates">Import template</Link> : <button className={styles.primaryButton} type="button" onClick={() => setCreateOpen(true)}>Tạo project</button>}
        />
      ) : filteredProjects.length === 0 ? (
        <EmptyState title="Không có kết quả" detail="Thử một tên ngắn hơn hoặc xoá bộ lọc tìm kiếm." action={<button className={styles.ghostButton} type="button" onClick={() => setSearch('')}>Xoá tìm kiếm</button>} />
      ) : (
        <div className={styles.projectGrid}>
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              template={templateById.get(project.templateId)}
              selected={selected.has(project.id)}
              onToggle={() => toggleProject(project.id)}
              onDelete={() => setDeleteTarget(project)}
              onDuplicate={() => setDuplicateTarget(project)}
            />
          ))}
        </div>
      )}

      {enqueueMutation.isError && <ErrorNotice message={getErrorMessage(enqueueMutation.error, 'Không thể đưa project vào queue.')} />}
    </div>
  );

  return (
    <>
      <div aria-hidden={createOpen || Boolean(deleteTarget) || Boolean(duplicateTarget)}>{content}</div>
      <CreateProjectDialog open={createOpen} templates={templates} busy={false} onClose={() => setCreateOpen(false)} onCreated={(project) => navigate(`/projects/${project.id}`)} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xoá project?"
        detail={`Project “${deleteTarget?.name ?? ''}” sẽ bị xoá khỏi workspace. Tác vụ đã enqueue vẫn giữ snapshot của nó.`}
        busy={deleteMutation.isPending}
        confirmLabel="Xoá project"
        onClose={() => setDeleteTarget(undefined)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
      <DuplicateDialog
        project={duplicateTarget}
        busy={duplicateMutation.isPending}
        onClose={() => setDuplicateTarget(undefined)}
        onConfirm={(name) => duplicateTarget && duplicateMutation.mutate({ id: duplicateTarget.id, name })}
      />
    </>
  );
}

function ProjectCard({ project, template, selected, onToggle, onDelete, onDuplicate }: {
  readonly project: Project;
  readonly template?: { id: string; name: string; thumbnailPath?: string };
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
}) {
  const ready = project.cards.length > 0 && project.cards.every(isCardRenderable);
  return (
    <article className={`${styles.projectCard} ${selected ? styles.projectCardSelected : ''}`}>
      <div className={styles.cardVisual}>
        {template?.thumbnailPath ? <img src={assetUrl(template.thumbnailPath)} alt="" /> : <div className={styles.visualFallback}><span>9:16</span><small>{template?.name ?? 'Template'}</small></div>}
        <label className={styles.cardCheck}>
          <span className={styles.srOnly}>Chọn {project.name}</span>
          <input type="checkbox" checked={selected} onChange={onToggle} />
        </label>
        <span className={styles.aspectChip}>VERTICAL / 30 FPS</span>
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardHeading}>
          <div><p className={styles.cardEyebrow}>PROJECT / {project.id.slice(0, 8)}</p><h2>{project.name}</h2></div>
          <StatusBadge status={ready ? 'succeeded' : 'queued'} />
        </div>
        <dl className={styles.metaList}>
          <div><dt>Template</dt><dd>{template?.name ?? 'Không còn template'}</dd></div>
          <div><dt>TTS</dt><dd>{project.tts.provider} · {project.tts.voiceId}</dd></div>
          <div><dt>Card</dt><dd>{project.cards.length.toString().padStart(2, '0')} ảnh</dd></div>
        </dl>
        <div className={styles.cardFooter}>
          <Link className={styles.openLink} to={`/projects/${project.id}`}>Mở editor <span aria-hidden="true">→</span></Link>
          <div className={styles.iconActions}>
            <button type="button" aria-label={`Nhân bản ${project.name}`} onClick={onDuplicate}>Nhân bản</button>
            <button type="button" aria-label={`Xoá ${project.name}`} onClick={onDelete}>Xoá</button>
          </div>
        </div>
      </div>
    </article>
  );
}

function isCardRenderable(card: Project['cards'][number]): boolean {
  if (card.script.trim()) return true;
  const holdSeconds = card.holdSeconds ?? 3;
  return Number.isFinite(holdSeconds) && holdSeconds >= 1 && holdSeconds <= 5;
}

function CreateProjectDialog({ open, templates, busy, onClose, onCreated }: {
  readonly open: boolean;
  readonly templates: readonly { id: string; name: string }[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onCreated: (project: Project) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [provider, setProvider] = useState<TtsProviderId>('google');
  const [blankOnly, setBlankOnly] = useState(true);
  const voicesQuery = useVoices(provider, !blankOnly);
  const [voiceId, setVoiceId] = useState('');
  const [speakingRate, setSpeakingRate] = useState('1');
  const [error, setError] = useState<string>();
  const createMutation = useMutation({
    mutationFn: (tts: ProjectTtsSettings) => api.createProject({ name: name.trim(), templateId, tts }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setName('');
      setError(undefined);
      onCreated(project);
      onClose();
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể tạo project.')),
  });

  useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templateId, templates]);
  useEffect(() => {
    if (!blankOnly && voicesQuery.data?.length && !voicesQuery.data.some((voice) => voice.id === voiceId)) setVoiceId(voicesQuery.data[0].id);
  }, [blankOnly, voiceId, voicesQuery.data]);

  const submit = () => {
    if (!name.trim() || !templateId || (!blankOnly && !voiceId)) {
      setError('Hãy điền tên, template và voice trước khi tạo.');
      return;
    }
    createMutation.mutate({ provider, voiceId: blankOnly ? BLANK_ONLY_VOICE_ID : voiceId, speakingRate: Number(speakingRate) || 1 });
  };
  return (
    <Dialog open={open} title="Tạo project mới" onClose={onClose} busy={busy || createMutation.isPending}>
      <div className={styles.dialogForm}>
        <p className={styles.dialogIntro}>Project card trống không cần kết nối TTS; bật narration khi bạn sẵn sàng viết script.</p>
        <Field label="Tên project" htmlFor="new-project-name"><input id="new-project-name" data-autofocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Ví dụ: Mẹo xây nhà" /></Field>
        <Field label="Template" htmlFor="new-project-template"><select id="new-project-template" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field>
        <label className={styles.field} htmlFor="new-project-blank-only"><span>Project chỉ dùng card trống (không TTS)</span><input id="new-project-blank-only" type="checkbox" checked={blankOnly} onChange={(event) => setBlankOnly(event.target.checked)} /></label>
        <div className={styles.formGrid}>
          <Field label="Provider" htmlFor="new-project-provider"><select id="new-project-provider" value={provider} onChange={(event) => { setProvider(event.target.value as TtsProviderId); setVoiceId(''); }} disabled={blankOnly}><option value="google">Google Cloud</option><option value="elevenlabs">ElevenLabs</option></select></Field>
          <Field label="Voice" htmlFor="new-project-voice"><select id="new-project-voice" value={blankOnly ? BLANK_ONLY_VOICE_ID : voiceId} onChange={(event) => setVoiceId(event.target.value)} disabled={blankOnly || voicesQuery.isLoading || voicesQuery.data?.length === 0}>{blankOnly ? <option value={BLANK_ONLY_VOICE_ID}>Không cần voice cho card trống</option> : <><option value="">{voicesQuery.isLoading ? 'Đang tải voice…' : 'Chọn voice'}</option>{voicesQuery.data?.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.languageCode}</option>)}</>}</select></Field>
        </div>
        <Field label="Tốc độ đọc" htmlFor="new-project-speed"><div className={styles.rangeRow}><input id="new-project-speed" type="range" min="0.5" max="2" step="0.05" value={speakingRate} onChange={(event) => setSpeakingRate(event.target.value)} disabled={blankOnly} /><output htmlFor="new-project-speed">{Number(speakingRate).toFixed(2)}×</output></div></Field>
        {error && <ErrorNotice message={error} />}
        <div className={styles.dialogActions}><button type="button" className={styles.ghostButton} onClick={onClose} disabled={createMutation.isPending}>Huỷ</button><button type="button" className={styles.primaryButton} onClick={submit} disabled={createMutation.isPending || templates.length === 0}>{createMutation.isPending ? 'Đang tạo…' : 'Tạo project'}</button></div>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({ open, title, detail, busy, confirmLabel, onClose, onConfirm }: {
  readonly open: boolean; readonly title: string; readonly detail: string; readonly busy: boolean; readonly confirmLabel: string; readonly onClose: () => void; readonly onConfirm: () => void;
}) {
  return <Dialog open={open} title={title} onClose={onClose} busy={busy}><div className={styles.dialogForm}><p className={styles.dialogIntro}>{detail}</p><div className={styles.dialogActions}><button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>Giữ lại</button><button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={busy}>{busy ? 'Đang xoá…' : confirmLabel}</button></div></div></Dialog>;
}

function DuplicateDialog({ project, busy, onClose, onConfirm }: { readonly project?: Project; readonly busy: boolean; readonly onClose: () => void; readonly onConfirm: (name: string) => void }) {
  const [name, setName] = useState('');
  useEffect(() => { if (project) setName(`${project.name} — bản sao`); }, [project]);
  return <Dialog open={Boolean(project)} title="Nhân bản project" onClose={onClose} busy={busy}><div className={styles.dialogForm}><Field label="Tên bản sao" htmlFor="duplicate-project-name"><input id="duplicate-project-name" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></Field><div className={styles.dialogActions}><button type="button" className={styles.ghostButton} onClick={onClose}>Huỷ</button><button type="button" className={styles.primaryButton} disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>{busy ? 'Đang nhân bản…' : 'Nhân bản'}</button></div></div></Dialog>;
}

function Field({ label, htmlFor, children }: { readonly label: string; readonly htmlFor: string; readonly children: ReactNode }) {
  return <label className={styles.field} htmlFor={htmlFor}><span>{label}</span>{children}</label>;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
