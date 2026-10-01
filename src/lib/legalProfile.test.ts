import { describe, expect, it } from 'vitest';

import {
  legalProfile,
  legalProfileDraftNotice,
  legalProfileEnglish,
} from '@/lib/legalProfile';

describe('legalProfile', () => {
  it('日本語と英語の運営者情報を別々に読み込む', () => {
    expect(legalProfile.businessName).toBe('OISINT Public Snapshot');
    expect(legalProfile.tradeName).toBe('OISINT');
    expect(legalProfileEnglish.address).toBe(
      'Public example; configure operator details before production use',
    );
    expect(legalProfileEnglish.governingLaw).toBe('Configure before production use');
    expect(legalProfileEnglish.disclosureFee).toBe('Configure before production use');
    expect(legalProfileEnglish.disclosureResponseTime).toBe('Configure before production use');
    expect(legalProfile.certifiedPrivacyOrganization).toBe('なし');
    expect(legalProfileEnglish.certifiedPrivacyOrganization).toBe('None');
  });

  it('日英版の運営者情報が未入力扱いにならない', () => {
    expect(legalProfileDraftNotice()).toContain('運営者情報は入力用JSONから読み込んでいます');
    expect(legalProfileDraftNotice()).not.toContain('未入力項目');
    expect(legalProfileDraftNotice('en')).toContain('Operator details are loaded');
    expect(legalProfileDraftNotice('en')).not.toContain('Missing fields');
  });
});
