import Head from 'expo-router/head';
import { useEffect } from 'react';

import { LegalDocumentPage, type LegalDocumentSection } from '@/components/LegalDocumentPage';
import { legalProfileEnglish } from '@/lib/legalProfile';

const SECTIONS: LegalDocumentSection[] = [
  {
    number: '01',
    title: 'Scope',
    lead: 'These Terms of Service (the “Terms”) set out the conditions for using OISINT (the “Service”). By using the Service, you agree to these Terms.',
  },
  {
    number: '02',
    title: 'The Service',
    bullets: [
      'OISINT organizes natural-language investigation requests and presents restaurant candidates and supporting evidence based on public information.',
      'In a shared investigation, conditions, votes, and progress are shared among participants who have access to the invitation link.',
      'Plus purchase and entitlement integration through RevenueCat is implemented. If purchasing is enabled, the order surface and specified-transactions notice will show the price, contract period, renewal, cancellation and refund terms, and service region before an order; this page does not assert a price.',
    ],
  },
  {
    number: '03',
    title: 'Registration and age requirement',
    bullets: [
      'You must provide accurate information and are responsible for managing your account and invitation links.',
      'Under the Service’s current usage policy, you must be at least 18 years old to use the Service. The applicable region and external AI provider requirements will be confirmed before public release.',
      'Persons under 18 may not use the Service. If an external service has stricter requirements, those requirements take precedence.',
    ],
  },
  {
    number: '04',
    title: 'User input, AI, and public information',
    bullets: [
      'Some input text may be sent to external search and AI providers for search, candidate organization, and evidence evaluation. See the Privacy Notice and External Transmission Notice for details.',
      'Results are supplementary information based on public sources. You must confirm opening hours, prices, availability, allergy accommodations, and other important matters directly with the restaurant.',
      'AI-generated explanations and evaluations may contain errors, omissions, or outdated information. You are responsible for making the final decision.',
    ],
  },
  {
    number: '05',
    title: 'Prohibited activities',
    bullets: [
      'Violating laws, public order, or the rights of any third party.',
      'Entering false information or unnecessarily entering third-party personal information or sensitive information such as medical history, disabilities, or food allergies.',
      'Interfering with the Service or an external service, its servers, networks, or APIs, or attempting unauthorized access.',
      'Excessive automated access, scraping, or information collection that violates the terms of a source website.',
      'Impersonating another user or sharing an invitation link with a third party without authorization.',
      'Any other activity that the operator reasonably considers inappropriate for safe operation of the Service.',
    ],
  },
  {
    number: '06',
    title: 'Suspension and account termination',
    lead: 'If you violate these Terms, or if necessary to operate the Service safely, the operator may restrict use, delete an account, or suspend a shared investigation without prior notice.',
  },
  {
    number: '07',
    title: 'Intellectual property and attribution',
    bullets: [
      'Rights in the Service, including its screens, logo, software, and other content, belong to the operator or the applicable rights holder.',
      'Restaurant information and images may be subject to third-party rights and provider terms. You must not remove or alter required source attribution or credits.',
      'The operator may handle information you submit as necessary to provide and maintain the Service. Personal information is handled under the Privacy Notice.',
    ],
  },
  {
    number: '08',
    title: 'Changes, suspension, and termination of the Service',
    lead: 'The operator may change, suspend, or terminate all or part of the Service for maintenance, incidents, external-service outages, legal compliance, or other operational reasons. Material changes will be announced through the Service where reasonably practicable.',
  },
  {
    number: '09',
    title: 'Disclaimers and limitation of liability',
    bullets: [
      'The Service is provided on an “as is” and “as available” basis. The operator does not warrant accuracy, completeness, timeliness, fitness for a particular purpose, or continuous availability.',
      'Except in cases of willful misconduct or gross negligence, the operator is not liable for losses beyond the ordinary and direct scope of damage. This clause does not limit liability that cannot be limited under applicable consumer-protection laws.',
      'Reservations, orders, visits, prices, allergy matters, and other transactions or decisions must be confirmed and carried out between you and the restaurant.',
    ],
  },
  {
    number: '10',
    title: 'Changes to these Terms',
    lead: 'The operator may amend these Terms due to changes in law, the Service, or other necessary reasons. The operator will announce the amended content and effective date through the Service and, for material changes, use a reasonably accessible method of notice.',
  },
  {
    number: '11',
    title: 'Governing law, jurisdiction, and contact',
    details: [
      { label: 'Governing law', value: legalProfileEnglish.governingLaw },
      { label: 'Exclusive jurisdiction', value: legalProfileEnglish.jurisdiction },
      { label: 'Business name / trade name', value: `${legalProfileEnglish.businessName} / ${legalProfileEnglish.tradeName}` },
      { label: 'Contact', value: `The in-app Contact page / ${legalProfileEnglish.email}` },
    ],
  },
];

export default function EnglishTermsScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'en');
      document.title = 'OISINT | Terms of Service';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | Terms of Service</title>
        <meta name="description" content="Review the OISINT Terms of Service, AI-assisted information handling, prohibited activities, and disclaimers." />
      </Head>
      <LegalDocumentPage
        testID="terms-page-en"
        eyebrow="TERMS OF SERVICE"
        title="Terms of Service"
        copy="These Terms describe the conditions for using OISINT, including AI-assisted candidate information, prohibited activities, and disclaimers."
        draftTitle="Information to review before use"
        draftBody="Review these Terms, the Privacy Notice, the External Transmission Notice, and the purchase surface before use or purchase. Material changes will be announced through the Service with their effective date. The Japanese version and applicable law control in the event of any inconsistency."
        sections={SECTIONS}
        updatedAt="Last updated: August 18, 2026"
        footerLocale="en"
      />
    </>
  );
}
