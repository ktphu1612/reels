import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { RenderJob } from '@reelforge/core';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorNotice, LoadingBlock } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { ApiError } from '../lib/api';
import { useApi } from '../app/api-context';
import { useRealtimeStatus } from '../app/events';
import { queryKeys, useJobs } from '../app/query-hooks';
import styles from './QueuePage.module.css';

const filters = [
  ['all', 'Tất cả'], ['queued', 'Đang chờ'], ['running', 'Đang render'], ['succeeded', 'Hoàn tất'], ['failed', 'Thất bại'], ['cancelled', 'Đã huỷ'],
] as const;

export function QueuePage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const jobsQuery = useJobs();
  const realtime = useRealtimeStatus();
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all');
  const [cancelTarget, setCancelTarget] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string>();
  const jobs = jobsQuery.data ?? [];
  const visibleJobs = useMemo(() => jobs.filter((job) => filter === 'all' || job.status === filter), [filter, jobs]);
  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: async (job) => {
      setCancelTarget(undefined);
      setAnnouncement(`Job ${job.snapshot.project.name} đã được huỷ.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
    onError: (reason) => setNotice(getErrorMessage(reason, 'Không thể huỷ job.')),
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) => api.retryJob(id),
    onSuccess: async (job) => {
      setAnnouncement(`Job ${job.snapshot.project.name} đã được đưa lại vào queue.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
    onError: (reason) => setNotice(getErrorMessage(reason, 'Không thể retry job.')),
  });
  const openOutputMutation = useMutation({
    mutationFn: () => api.openOutputDirectory(),
    onSuccess: () => setNotice('Đã mở thư mục output trên PC này.'),
    onError: (reason) => setNotice(getErrorMessage(reason, 'Không thể mở thư mục output.')),
  });

  if (jobsQuery.isLoading) return <LoadingBlock label="Đang tải queue…" />;
  if (jobsQuery.isError) return <ErrorNotice message="Không thể tải queue. Kiểm tra worker và server local." />;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div><p className={styles.kicker}>WORKSPACE / QUEUE</p><h1 aria-label="Hàng đợi render">Hàng đợi render <span aria-hidden="true">{jobs.length.toString().padStart(2, '0')}</span></h1><p className={styles.subtitle}>Job dùng snapshot bất biến; mất kết nối trình duyệt không làm mất tác vụ.</p></div>
        <div className={`${styles.realtime} ${realtime.connected ? styles.realtimeLive : ''}`}><span aria-hidden="true" /> <strong>Trạng thái realtime</strong><small>{realtime.connected ? 'SSE đang hoạt động' : 'Đang kết nối lại · queue vẫn an toàn'}</small></div>
      </header>
      <div className={styles.filterBar} role="group" aria-label="Lọc trạng thái queue">
        {filters.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? styles.filterActive : ''} onClick={() => setFilter(value)}>{label}<span>{value === 'all' ? jobs.length : jobs.filter((job) => job.status === value).length}</span></button>)}
      </div>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">{announcement}</div>
      {visibleJobs.length === 0 ? <EmptyState title={filter === 'all' ? 'Queue đang trống' : 'Không có job trong nhóm này'} detail="Khi bạn đưa một project vào hàng đợi, job sẽ xuất hiện ở đây và được worker xử lý bền vững." /> : <div className={styles.jobList}>{visibleJobs.map((job) => <JobRow key={job.id} job={job} onCancel={() => setCancelTarget(job.id)} onRetry={() => retryMutation.mutate(job.id)} onOpenOutput={() => openOutputMutation.mutate()} busy={cancelMutation.isPending || retryMutation.isPending || openOutputMutation.isPending} />)}</div>}
      <Dialog open={Boolean(cancelTarget)} title="Huỷ job đang chạy?" onClose={() => setCancelTarget(undefined)} busy={cancelMutation.isPending}>
        <div className={styles.dialogBody}><p>Worker sẽ dừng ở điểm an toàn và giữ lịch sử job. Bạn có thể retry lại nếu cần.</p><div className={styles.dialogActions}><button className={styles.ghostButton} type="button" onClick={() => setCancelTarget(undefined)} disabled={cancelMutation.isPending}>Giữ lại</button><button className={styles.dangerButton} type="button" onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget)} disabled={cancelMutation.isPending}>{cancelMutation.isPending ? 'Đang huỷ…' : 'Huỷ job'}</button></div></div>
      </Dialog>
    </div>
  );
}

function JobRow({ job, onCancel, onRetry, onOpenOutput, busy }: { readonly job: RenderJob; readonly onCancel: () => void; readonly onRetry: () => void; readonly onOpenOutput: () => void; readonly busy: boolean }) {
  const errorMessage = job.error?.message;
  return <article className={styles.jobRow}>
    <div className={styles.jobMain}><div className={styles.jobTitle}><span className={styles.jobId}>JOB / {job.id.slice(0, 8)}</span><StatusBadge status={job.status} /></div><h2>{job.snapshot.project.name}</h2><p>{job.snapshot.project.cards.length} card · {job.snapshot.project.tts.provider} · {job.snapshot.project.tts.voiceId}</p></div>
    <div className={styles.jobProgress}><div className={styles.progressHeader}><span>{job.status === 'running' ? 'Đang xử lý composition' : job.status === 'succeeded' ? 'Output sẵn sàng' : job.status === 'failed' ? 'Cần kiểm tra' : 'Đang chờ worker'}</span><strong>{Math.round(job.progress)}%</strong></div><div className={styles.progressTrack}><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div><div className={styles.progressMeta}><span>Lần thử {job.attempts}</span><span>{formatTime(job.updatedAt)}</span></div></div>
    <div className={styles.jobActions}>{job.status === 'running' && <button className={styles.ghostButton} type="button" onClick={onCancel} disabled={busy}>Huỷ</button>}{(job.status === 'failed' || job.status === 'cancelled') && <button className={styles.ghostButton} type="button" onClick={onRetry} disabled={busy}>Retry</button>}{job.status === 'succeeded' && <button className={styles.primaryButton} type="button" onClick={onOpenOutput} disabled={busy}>Mở thư mục output</button>}</div>
    {errorMessage && <p className={styles.jobError} role="alert">{errorMessage}</p>}
  </article>;
}

function formatTime(value: string): string { try { return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return '—'; } }
function getErrorMessage(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : fallback; }
