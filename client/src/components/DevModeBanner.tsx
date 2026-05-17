import { useEffect, useState } from 'react';

export function DevModeBanner() {
  const [isDev, setIsDev] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/mode')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled && data?.mode === 'dev') setIsDev(true);
      })
      .catch(() => {
        // silent — production behaviour if fetch fails
      });
    return () => { cancelled = true; };
  }, []);

  if (!isDev) return null;

  return (
    <div
      role="alert"
      data-testid="dev-mode-banner"
      style={{
        backgroundColor: '#dc2626',
        color: 'white',
        padding: '8px 16px',
        textAlign: 'center',
        fontWeight: 700,
        fontSize: '14px',
        letterSpacing: '0.5px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      🚧 DEV MODE — Mission extraction & evidence judging using Claude Haiku 3.5 (cheaper, separate quota pool). Unset WYSHBONE_ENV in Replit secrets to return to production models (gpt-4o-mini).
    </div>
  );
}
