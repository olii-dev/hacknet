import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.HACKNET_CONFIG;

export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

export function getFunctionsUrl() {
  return `${config.supabaseUrl}/functions/v1`;
}
