import { supabase } from '@/lib/supabase';

export async function deleteInvestigation(investigationId: string): Promise<void> {
  if (!investigationId.trim()) {
    throw new InvestigationOperationError('調査を削除できませんでした。');
  }

  // Edge Function が現在のJWTを検証し、削除者はJWT subjectから決める。
  // user idをrequest bodyへ渡さない（delete-investigation契約 / #167）。
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new InvestigationOperationError('認証が必要です。');
  }

  const { data, error } = await supabase.functions.invoke('delete-investigation', {
    body: { investigationId },
  });
  if (error || !isDeletedResponse(data)) {
    throw new InvestigationOperationError('調査を削除できませんでした。');
  }
}

export class InvestigationOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvestigationOperationError';
  }
}

function isDeletedResponse(value: unknown): value is { deleted: true } {
  return !!value && typeof value === 'object' && 'deleted' in value && value.deleted === true;
}
