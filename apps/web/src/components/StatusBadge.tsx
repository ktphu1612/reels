import styles from './StatusBadge.module.css';

const labels: Record<string, string> = {
  queued: 'Đang chờ', running: 'Đang render', succeeded: 'Đã hoàn tất', failed: 'Thất bại', cancelled: 'Đã huỷ',
};

export function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`${styles.badge} ${styles[status] ?? ''}`}><span className={styles.dot} aria-hidden="true" />{labels[status] ?? status}</span>;
}
