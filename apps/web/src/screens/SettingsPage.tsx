import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { SettingsPublic, TemplateManifest, TtsProviderId } from '@reelforge/core';
import { Dialog } from '../components/Dialog';
import { ErrorNotice, LoadingBlock } from '../components/Feedback';
import { ApiError } from '../lib/api';
import { buildSettingsUpdate, type SettingsDraft } from '../lib/settings';
import { useApi } from '../app/api-context';
import { queryKeys, useSettings, useTemplates } from '../app/query-hooks';
import styles from './SettingsPage.module.css';

const emptyDraft: SettingsDraft = { outputDirectory: '', concurrency: 1, googleKey: '', elevenlabsKey: '', clearGoogle: false, clearElevenlabs: false };

export function SettingsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const templatesQuery = useTemplates();
  const [draft, setDraft] = useState<SettingsDraft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [validation, setValidation] = useState<Partial<Record<TtsProviderId, string>>>({});
  const backgroundRef = useRef<HTMLInputElement>(null);
  const thumbnailRef = useRef<HTMLInputElement>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateDeleteTarget, setTemplateDeleteTarget] = useState<TemplateManifest>();

  useEffect(() => {
    if (!settingsQuery.data || dirty) return;
    setDraft((current) => ({ ...current, outputDirectory: settingsQuery.data.outputDirectory, concurrency: settingsQuery.data.concurrency }));
  }, [dirty, settingsQuery.data]);

  const updateDraft = (update: Partial<SettingsDraft>) => { setDraft((current) => ({ ...current, ...update })); setDirty(true); setNotice(undefined); setError(undefined); };
  const saveMutation = useMutation({
    mutationFn: () => api.updateSettings(buildSettingsUpdate(draft)),
    onSuccess: async (value) => {
      setDirty(false);
      setNotice('Đã lưu cài đặt local. Key chỉ được ghi vào backend và không quay lại trình duyệt.');
      setError(undefined);
      await queryClient.setQueryData(queryKeys.settings, value);
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể lưu cài đặt. Các giá trị chưa bị xoá.')),
  });
  const validateMutation = useMutation({
    mutationFn: (provider: TtsProviderId) => api.validateCredentials(provider),
    onSuccess: (result, provider) => setValidation((current) => ({ ...current, [provider]: result.ready ? 'Credential hợp lệ.' : result.message ?? 'Credential chưa sẵn sàng.' })),
    onError: (reason, provider) => setValidation((current) => ({ ...current, [provider]: getErrorMessage(reason, `Không thể validate ${provider}.`) })),
  });
  const voicePreviewMutation = useMutation({
    mutationFn: async (provider: TtsProviderId) => {
      const voices = await api.listVoices(provider, 'vi-VN');
      const voice = voices[0];
      if (!voice) throw new Error('Provider chưa có voice tiếng Việt.');
      return api.previewTts({ provider, voiceId: voice.id, text: 'Đây là bản nghe thử ReelForge Studio.', speakingRate: 1 });
    },
    onSuccess: (blob) => { if (typeof Audio !== 'undefined') { const audio = new Audio(URL.createObjectURL(blob)); void audio.play().catch(() => undefined); } setNotice('Đã phát voice preview.'); },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể tạo voice preview.')),
  });
  const importTemplateMutation = useMutation({
    mutationFn: async () => {
      const background = backgroundRef.current?.files?.[0];
      if (!templateName.trim() || !background) throw new Error('Cần tên template và gameplay video.');
      return api.importTemplate({ name: templateName.trim(), background, thumbnail: thumbnailRef.current?.files?.[0] });
    },
    onSuccess: async () => {
      setTemplateName('');
      if (backgroundRef.current) backgroundRef.current.value = '';
      if (thumbnailRef.current) thumbnailRef.current.value = '';
      setNotice('Đã import template với layout mặc định.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể import template.')),
  });
  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: async () => {
      setTemplateDeleteTarget(undefined);
      setNotice('Đã xoá template khỏi thư viện.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
    onError: (reason) => setError(getErrorMessage(reason, 'Không thể xoá template.')),
  });

  if (settingsQuery.isLoading) return <LoadingBlock label="Đang tải settings…" />;
  if (settingsQuery.isError) return <ErrorNotice message="Không thể tải settings local." />;
  const settings = settingsQuery.data;
  if (!settings) return <LoadingBlock label="Đang tải settings…" />;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}><div><p className={styles.kicker}>SYSTEM / SETTINGS</p><h1>Settings</h1><p className={styles.subtitle}>Các thiết lập chỉ áp dụng trên PC này. Secret luôn write-only; blank nghĩa là giữ nguyên.</p></div><div className={styles.localSeal}><span aria-hidden="true">⌂</span><strong>LOCAL WORKSPACE</strong><small>Không có cloud account</small></div></header>
      {error && <ErrorNotice message={error} />}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.settingsGrid}>
        <section className={styles.panel} aria-labelledby="runtime-heading"><div className={styles.panelHeader}><div><p className={styles.panelKicker}>01 / RUNTIME</p><h2 id="runtime-heading">Output & worker</h2></div></div><div className={styles.formStack}><Field label="Thư mục output" htmlFor="output-directory"><input id="output-directory" value={draft.outputDirectory} onChange={(event) => updateDraft({ outputDirectory: event.target.value })} placeholder="D:\\ReelForge\\outputs" /></Field><Field label="Concurrency worker" htmlFor="concurrency"><select id="concurrency" value={draft.concurrency} onChange={(event) => updateDraft({ concurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} job{value > 1 ? 's' : ''} đồng thời</option>)}</select></Field><p className={styles.helper}>MP4 mặc định: H.264/AAC · 720 × 1280 · 30 fps · CRF 20.</p></div></section>
        <section className={styles.panel} aria-labelledby="provider-heading"><div className={styles.panelHeader}><div><p className={styles.panelKicker}>02 / TTS PROVIDERS</p><h2 id="provider-heading">Credentials & voice check</h2></div><span className={styles.privateTag}>PRIVATE</span></div><ProviderSettings provider="google" label="Google Cloud" status={settings.providers.google} keyValue={draft.googleKey} clear={draft.clearGoogle} onKeyChange={(value) => updateDraft({ googleKey: value, clearGoogle: false })} onClear={() => updateDraft({ googleKey: '', clearGoogle: true })} onValidate={() => validateMutation.mutate('google')} onPreview={() => voicePreviewMutation.mutate('google')} validating={validateMutation.isPending} previewing={voicePreviewMutation.isPending} result={validation.google} />
          <ProviderSettings provider="elevenlabs" label="ElevenLabs" status={settings.providers.elevenlabs} keyValue={draft.elevenlabsKey} clear={draft.clearElevenlabs} onKeyChange={(value) => updateDraft({ elevenlabsKey: value, clearElevenlabs: false })} onClear={() => updateDraft({ elevenlabsKey: '', clearElevenlabs: true })} onValidate={() => validateMutation.mutate('elevenlabs')} onPreview={() => voicePreviewMutation.mutate('elevenlabs')} validating={validateMutation.isPending} previewing={voicePreviewMutation.isPending} result={validation.elevenlabs} /></section>
        <section id="templates" className={styles.panel} aria-labelledby="templates-heading"><div className={styles.panelHeader}><div><p className={styles.panelKicker}>03 / TEMPLATE LIBRARY</p><h2 id="templates-heading">Import clean template</h2></div><span className={styles.privateTag}>MANIFEST V2</span></div><p className={styles.helper}>Gameplay video bắt buộc; template không còn sticker cố định. Layout mặc định được lưu trong manifest.</p><div className={styles.formStack}><Field label="Tên template" htmlFor="template-name"><input id="template-name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Minecraft survival / clean" /></Field><Field label="Gameplay video" htmlFor="template-background"><input id="template-background" ref={backgroundRef} type="file" accept="video/mp4,video/webm,video/quicktime" /></Field><Field label="Thumbnail (tuỳ chọn)" htmlFor="template-thumbnail"><input id="template-thumbnail" ref={thumbnailRef} type="file" accept="image/png,image/jpeg,image/webp" /></Field><div className={styles.layoutSummary}><span className={styles.layoutMark} aria-hidden="true">9:16</span><div><strong>Layout mặc định</strong><p>Card contain · x 5% · y 38% · 90% × 25%<br />Meme slot · x 30% · y 63% · 40% × 31%</p></div></div><button className={styles.primaryButton} type="button" onClick={() => importTemplateMutation.mutate()} disabled={importTemplateMutation.isPending}>{importTemplateMutation.isPending ? 'Đang import…' : 'Import template'}</button><div className={styles.templateList}><div className={styles.templateListHeader}><strong>Template hiện có</strong><span>{templatesQuery.data?.length ?? 0}</span></div>{templatesQuery.data?.map((item) => <div className={styles.templateItem} key={item.id}><span>{item.name}</span><button type="button" className={styles.subtleButton} aria-label={`Xoá template ${item.name}`} onClick={() => setTemplateDeleteTarget(item)}>Xoá</button></div>)}</div></div></section>
      </div>
      <div className={styles.saveBar}><span>{dirty ? 'Có thay đổi chưa lưu' : 'Settings đã đồng bộ'}</span><button className={styles.primaryButton} type="button" onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>{saveMutation.isPending ? 'Đang lưu…' : 'Lưu cài đặt'}</button></div>
      <Dialog open={Boolean(templateDeleteTarget)} title="Xoá template?" onClose={() => setTemplateDeleteTarget(undefined)} busy={deleteTemplateMutation.isPending}><div className={styles.templateDeleteDialog}><p>Template “{templateDeleteTarget?.name ?? ''}” sẽ bị xoá khỏi thư viện. Các job đã enqueue vẫn giữ snapshot.</p><div className={styles.dialogActions}><button className={styles.subtleButton} type="button" onClick={() => setTemplateDeleteTarget(undefined)} disabled={deleteTemplateMutation.isPending}>Giữ lại</button><button className={styles.dangerButton} type="button" onClick={() => templateDeleteTarget && deleteTemplateMutation.mutate(templateDeleteTarget.id)} disabled={deleteTemplateMutation.isPending}>{deleteTemplateMutation.isPending ? 'Đang xoá…' : 'Xoá template'}</button></div></div></Dialog>
    </div>
  );
}

function ProviderSettings({ provider, label, status, keyValue, clear, onKeyChange, onClear, onValidate, onPreview, validating, previewing, result }: { readonly provider: TtsProviderId; readonly label: string; readonly status: SettingsPublic['providers']['google']; readonly keyValue: string; readonly clear: boolean; readonly onKeyChange: (value: string) => void; readonly onClear: () => void; readonly onValidate: () => void; readonly onPreview: () => void; readonly validating: boolean; readonly previewing: boolean; readonly result?: string }) {
  const fieldId = `${provider}-api-key`;
  return <div className={styles.providerBlock}><div className={styles.providerHeader}><div><strong>{label}</strong><span className={status.ready ? styles.ready : styles.notReady}>{status.ready ? 'Đã cấu hình' : 'Chưa cấu hình'}</span></div>{status.maskedKey && <code>{status.maskedKey}</code>}</div><label className={styles.field} htmlFor={fieldId}><span>{label} API key <em>(write-only)</em></span><input id={fieldId} aria-label={`${label} API key`} name={`${provider}ApiKey`} type="password" autoComplete="new-password" value={keyValue} onChange={(event) => onKeyChange(event.target.value)} placeholder="Để trống nếu không đổi" /></label><div className={styles.providerActions}><button type="button" className={styles.subtleButton} onClick={onClear}>{clear ? 'Bỏ xoá key' : `Xoá key ${label}`}</button><button type="button" className={styles.subtleButton} onClick={onValidate} disabled={validating}>{validating ? 'Đang validate…' : 'Validate credential'}</button><button type="button" className={styles.subtleButton} onClick={onPreview} disabled={previewing}>{previewing ? 'Đang preview…' : 'Preview voice'}</button></div>{result && <p className={styles.providerResult} role="status">{result}</p>}</div>;
}

function Field({ label, htmlFor, children }: { readonly label: string; readonly htmlFor: string; readonly children: ReactNode }) { return <label className={styles.field} htmlFor={htmlFor}><span>{label}</span>{children}</label>; }
function getErrorMessage(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback; }
