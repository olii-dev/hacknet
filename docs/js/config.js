// Hacknet Supabase configuration
window.HACKNET_CONFIG = {
  supabaseUrl: 'https://ccgwylcpqhepkqsxjtlh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjZ3d5bGNwcWhlcGtxc3hqdGxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTI0NjMsImV4cCI6MjA5ODU2ODQ2M30.ZpsGZJLQ5NZ4xBXZxM0cDZWJGgm9YxpMDRAbhMjBksk',
  // Storage backend = Mega.nz via Supabase Edge Functions.
  // Leave filesApiUrl/uploadWorkerUrl BLANK to route uploads/downloads/previews
  // through the mega-upload / mega-preview Edge Functions (see docs/js/api.js).
  filesApiUrl: '',
  uploadWorkerUrl: '',
  maxUploadBytes: 50 * 1024 * 1024, // 50 MB
  maxThumbnailBytes: 5 * 1024 * 1024, // 5 MB
  megaQuotaPerAccount: 20 * 1024 * 1024 * 1024, // ~20 GB per Mega account
  autoApprove: false,
};
