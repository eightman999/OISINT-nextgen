import Head from 'expo-router/head';
import { useEffect } from 'react';

import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: 'Information used to maintain sign-in state',
    details: [
      { label: 'Storage location', value: 'The user’s browser (localStorage).' },
      { label: 'Content', value: 'Authentication information used to maintain sign-in state.' },
      { label: 'Recipient', value: 'Supabase (database and authentication provider).' },
      { label: 'Purpose', value: 'Maintain sign-in state and display the user’s investigations.' },
    ],
    notes: ['While an investigation screen is open, synchronization requests are also sent to the same recipient to keep candidate and vote changes consistent.'],
  },
  {
    number: '02',
    title: 'Optional preference and health-related settings',
    details: [
      { label: 'Storage location', value: 'The user’s browser (localStorage), generally only on that device.' },
      { label: 'Content', value: 'Likes, avoidances, allergies, and health-related purposes.' },
      { label: 'Recipient and data sent', value: 'Likes and avoidances are included in a search request when an investigation starts. Allergies and health-related purposes are not included in the search request or sent to search/AI providers. They are stored in Supabase only when the user selects Save in the account screen.' },
      { label: 'Purpose', value: 'Reorder candidate restaurants for the user.' },
    ],
  },
  {
    number: '03',
    title: 'Other browser-initiated transmissions',
    details: [
      { label: 'Data', value: 'IP address and browser information transmitted as part of communications.' },
      { label: 'Temporary storage (sessionStorage)', value: 'When an owner reuses their own previous investigation text, a one-time copy bound to that account ID may be stored in the same browser tab. It is removed after reading, expiry, or an account mismatch.' },
      { label: 'Offline storage (Cache API)', value: 'The Service Worker stores only static files from the OISINT origin. Investigation text, conditions, votes, authentication information, and external API responses are not cached.' },
      { label: 'Candidate photos', value: 'No external candidate-photo CDN is contacted by the current implementation. Candidate cards display no photos or generated substitutes.' },
    ],
    notes: ['There is no automatic connection to a candidate-photo CDN in the current implementation. Depending on user action, requests may also be sent to Google when signing in, Google Maps when opening a map, image providers when displaying profile images, and the user’s mail application when sending an inquiry.'],
  },
  {
    number: '04',
    title: 'Information used to prevent abuse and overload',
    details: [
      { label: 'Data', value: 'A non-reversible hash derived from the IP address.' },
      { label: 'Recipient', value: 'Supabase' },
      { label: 'Purpose', value: 'Limit excessive consecutive requests.' },
    ],
  },
  {
    number: '05',
    title: 'Investigation-related information sent to providers',
    details: [
      { label: 'Supabase', value: 'The original investigation text and related investigation data are stored and synchronized as part of the service.' },
      { label: 'Google (Gemini)', value: 'Free-text investigation requests, additional conditions, restaurant information, and public-source excerpts may be sent for parsing and evidence evaluation.' },
      { label: 'Geoapify Places API and Serper', value: 'Structured search conditions such as restaurant name, area, cuisine, and party size may be sent to the current place-discovery and web-search providers. The original free-text request is not sent directly to these providers.' },
      { label: 'Purpose', value: 'Search for candidate restaurants and collect and evaluate supporting evidence. Candidates shown or shared by OISINT are managed through a canonical Place record and provider link.' },
    ],
    notes: ['The current service configuration designates Google Gemini API as a paid API service. The account contract, input/output handling, and processing conditions must be confirmed before public release and are re-reviewed when the contract or service configuration changes.'],
  },
  {
    number: '06',
    title: 'Purchase and entitlement information (RevenueCat)',
    details: [
      { label: 'Recipient and data sent', value: 'When a permanent account uses purchase or entitlement re-check, the account UUID is used as the RevenueCat App User ID and purchase, entitlement, and renewal state may be synchronized with RevenueCat and the applicable Apple App Store or Google Play service. Investigation free text, name, email address, GPS, allergy, and health information are not sent to the billing provider.' },
      { label: 'Purpose', value: 'Confirm and synchronize Plus purchase status and access rights.' },
    ],
    notes: ['Deleting an OISINT account starts a RevenueCat customer deletion request but does not cancel a store subscription. Cancellation and refunds use the applicable store settings or support channel. Prices, contract periods, and service regions are shown on the purchase surface before an order.'],
  },
  {
    number: '07',
    title: 'Push notification transmission (OneSignal)',
    details: [
      { label: 'Recipient and data sent', value: 'Only after the user enables push notifications in the account screen, OISINT sends OneSignal the permanent account UUID as external_id, a fixed event type, investigation and notification UUIDs, and a fixed-format in-app route. The SDK may also process delivery data such as push token, device/OS, language, timezone, usage timestamps/counts, and IP information. Location sharing is disabled. Investigation text, condition text, restaurant names, display names, Taste Profile content, GPS, email addresses, authentication information, and share tokens are not sent.' },
      { label: 'Purpose', value: 'Deliver investigation-completion, joined-group update, and ranking-change notifications to iOS or Android and return the user to the relevant investigation.' },
    ],
    notes: ['Permission is not requested at first launch. The user can opt out in the account screen; logout or account switching detaches the old notification destination, and account deletion first requests deletion of the OneSignal User.'],
  },
  {
    number: '08',
    title: 'How to delete stored information',
    bullets: [
      'Preference and health-related settings can be deleted from the account screen using “Delete preferences only”. This removes them from the device and account where applicable.',
      'Browser-stored sign-in information can also be removed by deleting this site’s data in the browser settings.',
      'Deleting site data also removes sessionStorage and Cache API entries for this site.',
    ],
  },
  {
    number: '09',
    title: 'Cookies, advertising, and analytics',
    details: [
      { label: 'Current implementation', value: 'The OISINT application does not itself read or write cookies and does not send data to advertising providers for advertising purposes.' },
      { label: 'Application scope', value: 'This notice describes cookie, advertising, and analytics behavior observable in the application code. Applicable provider terms and operational settings also govern where relevant.' },
    ],
  },
];

export default function EnglishExternalTransmissionScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'en');
      document.title = 'OISINT | External Transmission';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | External Transmission</title>
        <meta name="description" content="Review information stored in the browser and sent to OISINT service providers." />
      </Head>
      <LegalDocumentPage
        testID="external-transmission-page-en"
        eyebrow="EXTERNAL TRANSMISSION"
        title="External Transmission and Browser Storage Notice"
        copy="This English notice describes information stored in the browser and sent to providers used by OISINT. It is a convenience translation of the Japanese notice and does not by itself establish compliance with foreign privacy or electronic-communications laws."
        draftTitle="Information to review before use"
        draftBody="Review the browser storage, external recipients, and application-side transmission behavior before use. The Japanese version and applicable law control in the event of any inconsistency. Applicable provider terms and operational settings also govern where relevant."
        sections={SECTIONS}
        updatedAt="Last updated: August 30, 2026"
        footerLocale="en"
      />
    </>
  );
}
