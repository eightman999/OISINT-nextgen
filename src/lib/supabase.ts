import { createClient } from '@supabase/supabase-js';

import { providerSafeAuthStorage } from '@/lib/authStorage';
import { isTrustedSupabaseOrigin } from '@/lib/trustedOrigins';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const isSupabaseConfigured =
  !!supabaseAnonKey && isTrustedSupabaseOrigin(supabaseUrl);

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase URL / anon key が未設定です。'.concat(
      '.env.example をコピーして .env を作り、',
      'EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください。'
    )
  );
}

// The live provider and AuthProvider both reject operations when configuration is absent.
// Non-secret placeholders only keep Expo static rendering from failing at module evaluation time;
// they are never a fallback data path and never point at production.
export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'http://127.0.0.1:54321',
  supabaseAnonKey || 'static-export-placeholder',
  {
    auth: {
      storage: providerSafeAuthStorage,
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
