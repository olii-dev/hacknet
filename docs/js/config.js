(function installBasePath() {
  function detectBasePath() {
    const script = document.currentScript
      || document.querySelector('script[src*="config.js"]');
    if (script?.src) {
      const path = new URL('..', script.src).pathname;
      return path.endsWith('/') ? path : `${path}/`;
    }
    const { pathname } = window.location;
    if (pathname.endsWith('.html')) {
      return pathname.slice(0, pathname.lastIndexOf('/') + 1);
    }
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length > 1) {
      return `/${parts.slice(0, -1).join('/')}/`;
    }
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }

  const basePath = detectBasePath();
  if (!document.querySelector('base')) {
    const base = document.createElement('base');
    base.href = basePath;
    document.head.appendChild(base);
  }
  window.__HACKNET_BASE_PATH = basePath;
})();

// Hacknet Supabase configuration
window.HACKNET_CONFIG = {
  supabaseUrl: 'https://ccgwylcpqhepkqsxjtlh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjZ3d5bGNwcWhlcGtxc3hqdGxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTI0NjMsImV4cCI6MjA5ODU2ODQ2M30.ZpsGZJLQ5NZ4xBXZxM0cDZWJGgm9YxpMDRAbhMjBksk',
  basePath: window.__HACKNET_BASE_PATH,
  filesApiUrl: '',
  uploadWorkerUrl: '',
  maxUploadBytes: 15 * 1024 * 1024,
  megaQuotaPerAccount: 20 * 1024 * 1024 * 1024,
  autoApprove: true,
  creatorUsername: 'oli',
};
