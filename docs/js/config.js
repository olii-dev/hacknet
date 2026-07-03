// Hacknet Supabase configuration
window.HACKNET_CONFIG = {
  supabaseUrl: 'https://ccgwylcpqhepkqsxjtlh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjZ3d5bGNwcWhlcGtxc3hqdGxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTI0NjMsImV4cCI6MjA5ODU2ODQ2M30.ZpsGZJLQ5NZ4xBXZxM0cDZWJGgm9YxpMDRAbhMjBksk',
  // Public HTTPS URL of your Ubuntu file server (Cloudflare tunnel).
  // Uploads, downloads, and previews all use this — set after running install-on-ubuntu.sh
  filesApiUrl: 'https://lunch-fragrance-cope-compounds.trycloudflare.com',
  uploadWorkerUrl: 'https://lunch-fragrance-cope-compounds.trycloudflare.com', // alias for filesApiUrl (either works)
  maxUploadBytes: 1024 * 1024 * 1024, // 1 GB
  maxThumbnailBytes: 5 * 1024 * 1024, // 5 MB
  megaQuotaPerAccount: 20 * 1024 * 1024 * 1024, // ~20 GB per Mega account
  autoApprove: false,
};
