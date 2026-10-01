import Head from 'expo-router/head';
import { useEffect } from 'react';

import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';
import { legalProfileEnglish } from '@/lib/legalProfile';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: 'Operator name, address, and contact',
    details: [
      { label: 'Name or legal name', value: legalProfileEnglish.businessName },
      { label: 'Trade name', value: legalProfileEnglish.tradeName },
      { label: 'Address', value: legalProfileEnglish.address },
      { label: 'Representative name', value: legalProfileEnglish.representativeName },
      { label: 'Contact', value: `${legalProfileEnglish.phone} / ${legalProfileEnglish.email}` },
    ],
  },
  {
    number: '02',
    title: 'Information collected and stored',
    lead: 'OISINT stores the following information on its servers or in the browser, as applicable.',
    details: [
      { label: 'Account information', value: 'User ID; email address, name, and profile image URL when signing in with Google; and configured display name and profile image URL.' },
      { label: 'Investigation information', value: 'Investigation text, generated title, organized search text, search embeddings, additional conditions, votes, shared-investigation participation records, progress events including display names, and share tokens.' },
      { label: 'Operational analytics', value: 'Aggregate 1-day, 7-day, and 30-day counts are computed inside the database from existing investigations, shared participation, and progress events. Individual rows and identifiers are not sent to the operator dashboard or external services; the dashboard handles aggregate JSON only. Only permanent accounts can opt out from the account screen; anonymous accounts cannot use this setting.' },
      { label: 'Optional shared-investigation journey state', value: 'For each shared investigation, OISINT keeps only the user ID, first timestamps for share open, join, first action, return, and next-investigation creation, and counts of requirements added, votes, and next investigations. Investigation text, condition text, vote comments, restaurant names, display names, Taste Profile content, share tokens, notification bodies, IP addresses, and device data are not stored in these tables. Operator surfaces and external services receive only aggregate counts and rates, not individual rows. Permanent accounts can opt out from the account screen.' },
      { label: 'Post-visit feedback', value: 'Optional information such as visit date and ratings. Learning from this feedback for future recommendations runs only after the user explicitly opts in when saving it. Without opt-in, the feedback is not used for learning; it can later be reset or deleted.' },
      { label: 'Optional preference profile', value: 'Aggregated preference values, likes, avoidances, attribute-specific search vectors (768 dimensions), and consent records when the user selects Save in the account screen. Allergies, religious constraints, and absolute avoidances are not mixed into these vectors. Audit events for saving and deleting are also stored.' },
      { label: 'Abuse-prevention information', value: 'A hash value derived from the IP address in a form that cannot be restored to the original address.' },
      { label: 'Optional push-notification information', value: 'Notification enablement, OS permission status, group-update preference, fixed event type, investigation and notification UUIDs, and sent/open timestamps. Notification bodies do not store investigation text, condition text, restaurant names, display names, Taste Profile content, GPS, authentication information, or share tokens.' },
      { label: 'Browser and optional saved information', value: 'Authentication state and preferences may be stored in the browser. Allergies and health-related purposes are not sent in investigation search requests. GPS coordinates are sent to Geoapify only while running a current-location search; they are not stored in OISINT raw queries, share URLs, investigation events, database columns, or logs.' },
    ],
    notes: ['Contact and feedback messages are sent through the user’s mail application and are not stored on OISINT servers.'],
  },
  {
    number: '03',
    title: 'Purposes of use',
    lead: 'Collected information is used only for the following purposes:',
    bullets: [
      'Providing restaurant investigation services, including parsing requests, searching candidate restaurants, collecting and evaluating public-source evidence, and displaying rankings.',
      'Maintaining sign-in status and displaying or synchronizing the user’s investigation data.',
      'Displaying members, aggregating votes, and showing progress in shared investigations.',
      'Improving the shared-investigation journey by aggregating minimal share-open, join, first-action, ranking-change, return, and next-investigation state without storing personal text. Permanent accounts can opt out from the account screen.',
      'When explicitly enabled by the user, notifying them of investigation completion, updates in joined groups, or ranking changes and providing a route back to that investigation.',
      'Creating non-identifying 1-day, 7-day, and 30-day operational aggregates from existing investigation data. Only permanent accounts can opt out from the account screen; anonymous accounts cannot use this setting.',
      'Personalizing candidate restaurants and supporting evidence based on the user’s explicit opt-in and aggregated preference, attribute-vector, or selection behavior. Feedback without opt-in is not used for learning.',
      'Using an attribute aggregate vector only after the minimum sample threshold and re-identification review are satisfied; an aggregate is not published or used for ranking before that review.',
      'Preventing abuse, limiting excessive requests, and maintaining service stability.',
      'Responding to inquiries and feedback.',
      'Creating statistics about restaurant facts that do not identify a specific individual.',
    ],
    notes: ['Reuse of collected evidence or aggregated values for future service improvement is not included until the operator confirms that purpose. This notice will be updated if that changes.'],
  },
  {
    number: '04',
    title: 'External recipients and transfers',
    lead: 'Some information is sent to external services to provide investigation features. GPS coordinates are sent to Geoapify only while running a current-location search and are not stored in OISINT investigation or sharing data. Do not enter personal information in free-text investigation requests.',
    details: [
      { label: '1. Google Gemini API (Google)', value: 'Purpose: parse investigation requests, evaluate restaurant information, and generate search data. Information sent: free-text requests, additional conditions, restaurant names and addresses, and excerpts from public web pages.' },
      { label: '2. Serper (search API)', value: 'Purpose: search public information about restaurants. Information sent: machine-generated search terms such as restaurant names and areas; the user’s original request is not sent.' },
      { label: '3. Geoapify Places API (Geoapify)', value: 'Purpose: search candidate restaurants around the current location or a named area. Information sent: GPS latitude/longitude during a current-location search, or a named area and search conditions for ordinary searches. OISINT does not store GPS coordinates in raw queries, share URLs, investigation events, database columns, or logs. Geoapify retention follows its terms and privacy notice; the specific contract and notice conditions will be confirmed before public release.' },
      { label: '4. Public web pages being investigated', value: 'Purpose: collect public pages as evidence for restaurant information. Information sent: an automated request to the target URL; the user’s information is not sent.' },
      { label: '5. Supabase (database and authentication)', value: 'Purpose: store and synchronize accounts, investigations, votes, and explicitly saved preference settings. Information stored: the information listed in Section 02.' },
      { label: '6. Cloudflare (delivery and API proxy)', value: 'Purpose: deliver the website, proxy API requests, and proxy public-page retrieval. Information passing through: request contents including investigation text, login tokens, IP address, and connection data.' },
      { label: '7. RevenueCat (purchase and entitlement)', value: 'Purpose: confirm and synchronize Plus purchase status and access rights. Information sent: the permanent account UUID is used as the App User ID, together with purchase, entitlement, and renewal state. Investigation free text, name, email address, GPS, allergy, and health information are not sent to the billing provider. Account deletion starts a RevenueCat customer deletion request but does not cancel a store subscription.' },
      { label: '8. OneSignal (push delivery)', value: 'Purpose: deliver user-enabled investigation-completion, group-update, and ranking-change push notifications to iOS or Android. Information sent: the permanent account UUID as external_id, a fixed event type, investigation and notification UUIDs, a fixed-format in-app route, and SDK data needed for delivery such as push token, device/OS, language, timezone, usage timestamps/counts, and IP information. Location sharing is disabled. Investigation text, condition text, restaurant names, display names, Taste Profile content, GPS, email addresses, authentication information, and share tokens are not sent. The user can opt out in the account screen; logout or account switching detaches the old destination, and account deletion first requests deletion of the OneSignal User.' },
    ],
    notes: ['Other browser-initiated requests may occur when signing in with Google, opening Google Maps, loading profile images, or sending an inquiry through the user’s mail application. The current implementation does not automatically connect to an external candidate-photo CDN.'],
  },
  {
    number: '05',
    title: 'Retention periods',
    details: [
      { label: 'Completed investigations', value: 'Anonymized six months after the last update. The request text and title are removed, and organized search text, embeddings, and conditions are anonymized or deleted as applicable.' },
      { label: 'Draft, failed, or interrupted investigations', value: 'Handled in the same way three months after the last update.' },
      { label: 'Votes', value: 'Deleted together with the investigation anonymization.' },
      { label: 'Investigation progress events', value: 'Deleted 30 days after creation.' },
      { label: 'Push notifications', value: 'The OISINT notification outbox (fixed event type, UUIDs, and sent/open state) is deleted 30 days after creation. Notification preferences remain until account deletion. Account deletion requests OneSignal User/Subscription deletion through the Delete User API; provider-side retention follows the applicable OneSignal terms, DPA, and operational configuration.' },
      { label: 'Operational analytics', value: 'Only the latest 1-day, 7-day, and 30-day aggregate snapshots are retained in the database. Snapshots are discarded when source rows change, an account is deleted, or a permanent account opts out. Aggregate values contain no individual rows or identifiers.' },
      { label: 'Shared-investigation journey state', value: 'Deleted when the related investigation is deleted or anonymized, when the account is deleted, or when a permanent account opts out. Existing investigation limits—six months after the last update for completed investigations and three months for other investigations—are the maximum retention period. Individual rows are not sent to external analytics services.' },
      { label: 'Account and preference profile', value: 'Personal attribute vectors and preference profiles are deleted by “Delete preferences only” or account deletion. Account deletion is also available from an anonymous session. Aggregates remain unpublished and unusable until the minimum-sample and re-identification review is complete; approved aggregates may remain only when they cannot reasonably be linked back to an individual. Audit events may remain with the actor identifier redacted.' },
      { label: 'Investigation-level deletion', value: 'An investigation owner can delete that investigation after an explicit confirmation step. The investigation text, requirements, votes, and progress records are deleted; shared place information and Evidence remain shared assets. The deleted investigation URL is not reused after deletion.' },
      { label: 'Browser-stored information', value: 'Can be removed at any time by deleting this site’s data in browser settings.' },
    ],
    notes: ['Backups and communication logs held by infrastructure providers are governed by the applicable provider terms and operational retention controls.'],
  },
  {
    number: '06',
    title: 'Requests for access, correction, and deletion',
    lead: 'The operator responds to requests concerning retained personal data as required by applicable Japanese law.',
    bullets: [
      'Notification of the purpose of use.',
      'Access: a copy may be provided in an electronic format such as CSV or JSON where practicable.',
      'Correction, addition, or deletion when retained data is inaccurate.',
      'Suspension of use, erasure, or suspension of third-party provision when statutory requirements are met.',
    ],
    details: [
      { label: 'Request contact', value: `${legalProfileEnglish.email}; use the subject “Personal Data Request”. The in-app Contact page may also be used.` },
      { label: 'Identity verification', value: legalProfileEnglish.disclosureIdentityVerification },
      { label: 'Response estimate', value: legalProfileEnglish.disclosureResponseTime },
      { label: 'Fee', value: legalProfileEnglish.disclosureFee },
      { label: 'Cases where access may be refused', value: 'Access may be refused in whole or in part where disclosure could harm the rights or safety of the requester or another person, materially interfere with operations, or violate another law.' },
    ],
    notes: ['Some shared-investigation participation records may be anonymized rather than deleted to preserve the integrity of the investigation record. Third-party restaurant information and non-identifying aggregate values are outside the scope of personal-data deletion.'],
  },
  {
    number: '07',
    title: 'Security measures',
    bullets: [
      'All communications use HTTPS encryption.',
      'Row-level access controls restrict database reads to the user and participants associated with the investigation.',
      'Database writes and external-service calls are limited to server-side processing; secret API keys are not placed in the browser.',
      'IP addresses are transformed into non-reversible hash values before storage.',
      'Allergies and health-related purposes are not included in investigation search requests; they are stored in Supabase only when the user explicitly selects Save. GPS coordinates are sent to Geoapify only during a current-location search and are not stored in OISINT investigation or sharing data.',
      'Personal attribute vectors are visible only to the same permanent user; aggregate vectors are service-role-only until a documented minimum-sample and re-identification review approves them.',
      'Retention periods are applied, and eligible investigation data is automatically anonymized or deleted.',
    ],
    details: [
      { label: 'External environment', value: 'Personal data is stored in Supabase infrastructure. Website delivery and communication proxying use Cloudflare infrastructure. The applicable provider terms and the release configuration govern processing locations.' },
    ],
  },
  {
    number: '08',
    title: 'Complaints and inquiries',
    details: [
      { label: 'Contact', value: legalProfileEnglish.email },
      { label: 'Public consultation', value: 'The Personal Information Protection Commission of Japan is available as a public consultation resource: https://www.ppc.go.jp/' },
      { label: 'Certified organization', value: legalProfileEnglish.certifiedPrivacyOrganization },
    ],
  },
  {
    number: '09',
    title: 'Revisions',
    bullets: [
      'Google Gemini is used under the service configuration selected for the release. Provider terms and processing details are reviewed when that configuration changes.',
      'This notice records application-side data flows. Provider terms, release configuration, and legally required regional notices apply where relevant.',
      'The operator will publish revisions on this page and provide prominent notice for material changes.',
    ],
  },
];

export default function EnglishPrivacyScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'en');
      document.title = 'OISINT | Privacy Notice';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | Privacy Notice</title>
        <meta name="description" content="Review how OISINT handles personal information, external recipients, retention, and deletion." />
      </Head>
      <LegalDocumentPage
        testID="privacy-page-en"
        eyebrow="PRIVACY NOTICE"
        title="Privacy Notice"
        copy="This English privacy notice describes how OISINT handles personal information and related data. It is a convenience translation of the Japanese notice and is not, by itself, a GDPR, UK GDPR, CCPA/CPRA, or other foreign-law compliance notice."
        draftTitle="Information to review before use"
        draftBody="Review the information collected, purposes, external recipients, retention, and deletion methods before use. The Japanese version and applicable law control in the event of any inconsistency. If OISINT is offered to residents of a specific country or region, local-law notices may also apply."
        sections={SECTIONS}
        updatedAt="Last updated: August 30, 2026"
        footerLocale="en"
      />
    </>
  );
}
