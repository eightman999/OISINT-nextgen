export const PERSONALIZATION_CONSENT_VERSION = 'personalization-v2';
export const PERSONALIZATION_CONSENT_PURPOSE = 'restaurant_recommendations';

export const PERSONALIZATION_CONSENT_LABEL =
  '回答・選択行動・取込タグ・明示した来店後感想から作った集約した好みを、店舗候補と選定根拠の個人化に使う';

export const PERSONALIZATION_RETENTION_LABEL =
  '好みプロフィールと個人属性ベクトルは「好みだけ削除」またはアカウント削除で削除します。監査イベントは個人識別子を匿名化して保持する場合があります。';

export type PersonalizationSaveSource = 'demo' | 'account' | 'maps_takeout';
