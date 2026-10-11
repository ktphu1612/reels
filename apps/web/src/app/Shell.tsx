import { NavLink, Outlet } from 'react-router-dom';
import { RealtimeProvider, useRealtimeStatus } from './events';
import styles from './Shell.module.css';

const links = [
  { to: '/projects', label: 'Projects', caption: 'Kho nội dung' },
  { to: '/queue', label: 'Queue', caption: 'Render bền vững' },
  { to: '/settings', label: 'Settings', caption: 'Thiết lập cục bộ' },
] as const;

export function Shell() {
  return <RealtimeProvider><ShellContent /></RealtimeProvider>;
}

function ShellContent() {
  const { connected } = useRealtimeStatus();
  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brandBlock}>
          <span className={styles.brandMark} aria-hidden="true">RF</span>
          <div>
            <p className={styles.brandName}>ReelForge</p>
            <p className={styles.brandCaption}>Studio / local console</p>
          </div>
        </div>
        <nav aria-label="Điều hướng chính" className={styles.nav}>
          <p className={styles.navLabel}>Workspace</p>
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}
            >
              <span className={styles.navDot} aria-hidden="true" />
              <span>
                <strong>{link.label}</strong>
                <small>{link.caption}</small>
              </span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.localNote}>
          <span className={`${styles.connectionDot} ${connected ? styles.connectionLive : ''}`} aria-hidden="true" />
          <div>
            <strong>{connected ? 'Đang kết nối realtime' : 'Đang chờ realtime'}</strong>
            <p>Render và API chỉ chạy trên PC này.</p>
          </div>
        </div>
      </aside>
      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>REELFORGE STUDIO</span>
            <span className={styles.localChip}><span aria-hidden="true">●</span> Local only</span>
          </div>
          <div className={styles.topbarStatus} aria-live="polite">
            <span className={`${styles.connectionDot} ${connected ? styles.connectionLive : ''}`} aria-hidden="true" />
            {connected ? 'SSE đang hoạt động' : 'SSE đang kết nối lại'}
          </div>
        </header>
        <div className={styles.content}><Outlet /></div>
      </main>
    </div>
  );
}
