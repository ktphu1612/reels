import styles from './Feedback.module.css';

export function ErrorNotice({ message }: { readonly message: string }) {
  return <p className={styles.error} role="alert"><span aria-hidden="true">!</span>{message}</p>;
}

export function EmptyState({ title, detail, action }: { readonly title: string; readonly detail: string; readonly action?: React.ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyGlyph} aria-hidden="true">＋</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function LoadingBlock({ label = 'Đang tải dữ liệu…' }: { readonly label?: string }) {
  return <div className={styles.loading} aria-live="polite"><span className={styles.loadingBar} />{label}</div>;
}
