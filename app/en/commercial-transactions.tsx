import Head from 'expo-router/head';
import { useEffect } from 'react';

import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';
import { legalProfileEnglish } from '@/lib/legalProfile';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: 'Seller / service provider',
    details: [
      { label: 'Name or legal name', value: legalProfileEnglish.businessName },
      { label: 'Trade name (as filed in the business notification)', value: legalProfileEnglish.tradeName },
      { label: 'Address', value: legalProfileEnglish.address },
      { label: 'Representative or person responsible for mail-order operations', value: legalProfileEnglish.representativeName },
      { label: 'Telephone number', value: legalProfileEnglish.phone },
      { label: 'Email address', value: legalProfileEnglish.email },
    ],
    notes: ['For an individual business, the legal name or registered trade name is shown as the underlying business identity, with the filed trade name listed separately.'],
  },
  {
    number: '02',
    title: 'Price / service fee',
    details: [
      { label: 'Current service status', value: 'RevenueCat and store purchase/entitlement integration is implemented. If purchasing is enabled, the purchase surface will show the price, service region, contract period, renewal, and other conditions.' },
      { label: 'If purchasing is enabled', value: 'Before an order, the relevant purchase surface will show the tax-inclusive price, contract period, available features, renewal conditions, service region, and any applicable total amount.' },
    ],
  },
  {
    number: '03',
    title: 'Additional costs',
    bullets: [
      'This page does not guess or state an unconfirmed price or payment amount. If purchasing is enabled, the actual store / RevenueCat product display will be available before an order.',
      'Internet access charges, telecommunications charges, devices, and similar costs required to use the Service are borne by the user.',
      'If payment fees, transfer fees, or optional charges apply in the future, the amount or calculation method will be shown before an order is placed.',
    ],
  },
  {
    number: '04',
    title: 'Payment method and timing',
    details: [
      { label: 'Payment method', value: 'If purchasing is enabled, the actual Apple App Store, Google Play, or supported Web Billing method through RevenueCat will be shown on the purchase surface.' },
      { label: 'Payment timing', value: 'The actual charge timing, such as at order, service start, or renewal, will be shown on the purchase surface. No fixed timing is asserted here.' },
    ],
  },
  {
    number: '05',
    title: 'Service delivery timing',
    details: [
      { label: 'Current service status', value: 'Free investigation features are provided after the request is submitted while the Service is available.' },
      { label: 'If a paid service is introduced', value: 'The start date, feature activation timing, and any delivery timing will be shown on the relevant order page.' },
    ],
  },
  {
    number: '06',
    title: 'Cancellation, termination, and refunds',
    details: [
      { label: 'Free use', value: 'Users may delete account or device-stored information through the applicable Service functions or browser settings.' },
      { label: 'If a paid service is introduced', value: 'Cancellation, termination, renewal cancellation, refund eligibility, deadlines, and fee allocation will be shown for each product or service before ordering.' },
      { label: 'Digital services', value: 'Conditions for cancellation or refunds after delivery begins will be shown in an easily accessible place and do not limit any non-waivable statutory right.' },
    ],
  },
  {
    number: '07',
    title: 'Application period and usage conditions',
    bullets: [
      'If an application period, capacity, service area, supported device, or recommended browser is specified, it will be shown on the relevant order page.',
      'Use of the Service is also subject to the Terms of Service, Privacy Notice, and External Transmission Notice.',
    ],
  },
  {
    number: '08',
    title: 'Contact',
    details: [
      { label: 'Contact', value: `The in-app Contact page / ${legalProfileEnglish.email}` },
      { label: 'Contact hours', value: legalProfileEnglish.contactHours },
    ],
  },
];

export default function EnglishCommercialTransactionsScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'en');
      document.title = 'OISINT | Specified Commercial Transactions';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | Specified Commercial Transactions</title>
        <meta name="description" content="Review OISINT information under Japan's Act on Specified Commercial Transactions." />
      </Head>
      <LegalDocumentPage
        testID="commercial-transactions-page-en"
        eyebrow="SPECIFIED COMMERCIAL TRANSACTIONS"
        title="Information under the Act on Specified Commercial Transactions"
        copy="This page organizes the information required for mail-order sales and paid services under Japanese law."
        draftTitle="Information to review before purchase"
        draftBody="If purchasing is enabled, review the price, contract period, renewal, cancellation and refund terms, and service region shown on the purchase surface before ordering. Store terms also apply to store purchase, cancellation, and refund procedures. The Japanese version and applicable law control in the event of any inconsistency."
        sections={SECTIONS}
        updatedAt="Last updated: August 18, 2026"
        footerLocale="en"
      />
    </>
  );
}
