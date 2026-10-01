import rawLegalProfile from '@/config/legal-profile.json';

export const LEGAL_PROFILE_PLACEHOLDER = '【legal-profile.json に記入】';
export const LEGAL_PROFILE_PLACEHOLDER_EN = '[Enter in legal-profile.json]';

type LegalProfile = typeof rawLegalProfile.ja;
type LegalProfileKey = keyof LegalProfile;

const FIELD_KEYS = Object.keys(rawLegalProfile.ja) as LegalProfileKey[];

const FIELD_LABELS: Record<LegalProfileKey, string> = {
  businessName: '事業者名',
  tradeName: '屋号',
  representativeName: '代表者名',
  address: '住所',
  phone: '電話番号',
  email: 'メールアドレス',
  contactHours: '受付時間',
  governingLaw: '準拠法',
  jurisdiction: '管轄裁判所',
  disclosureFee: '個人情報開示手数料',
  disclosureIdentityVerification: '個人情報開示時の本人確認方法',
  disclosureResponseTime: '個人情報開示請求への回答目安',
  certifiedPrivacyOrganization: '認定個人情報保護団体',
};

const FIELD_LABELS_EN: Record<LegalProfileKey, string> = {
  businessName: 'business name',
  tradeName: 'trade name',
  representativeName: 'representative name',
  address: 'address',
  phone: 'telephone number',
  email: 'email address',
  contactHours: 'contact hours',
  governingLaw: 'governing law',
  jurisdiction: 'jurisdiction',
  disclosureFee: 'personal data disclosure fee',
  disclosureIdentityVerification: 'identity verification method',
  disclosureResponseTime: 'disclosure response estimate',
  certifiedPrivacyOrganization: 'certified personal information protection organization',
};

function readProfile(profile: LegalProfile, placeholder: string): { [K in LegalProfileKey]: string } {
  return Object.fromEntries(
    FIELD_KEYS.map((key) => [key, profile[key].trim() || placeholder]),
  ) as { [K in LegalProfileKey]: string };
}

function missingFields(profile: LegalProfile): LegalProfileKey[] {
  return FIELD_KEYS.filter((key) => !profile[key].trim());
}

export const legalProfile = readProfile(rawLegalProfile.ja, LEGAL_PROFILE_PLACEHOLDER);

export const legalProfileEnglish = readProfile(rawLegalProfile.en, LEGAL_PROFILE_PLACEHOLDER_EN);

const missingJapaneseFields = missingFields(rawLegalProfile.ja);
const missingEnglishFields = missingFields(rawLegalProfile.en);

export const missingLegalProfileFields = missingJapaneseFields
  .map((key) => FIELD_LABELS[key]);

export function legalProfileDraftNotice(locale: 'ja' | 'en' = 'ja'): string {
  const missingFieldsForLocale = locale === 'en' ? missingEnglishFields : missingJapaneseFields;
  if (missingFieldsForLocale.length === 0) {
    return locale === 'en'
      ? 'Operator details are loaded from the input JSON. Confirm the content and applicable legal requirements before publication.'
      : '運営者情報は入力用JSONから読み込んでいます。公開前に内容と法的要件を確認してください。';
  }
  if (locale === 'en') {
    const missingEnglish = missingEnglishFields.map((key) => FIELD_LABELS_EN[key]);
    return `Missing fields in src/config/legal-profile.json: ${missingEnglish.join(', ')}`;
  }
  return `入力用ファイル src/config/legal-profile.json の未入力項目: ${missingLegalProfileFields.join('、')}`;
}
