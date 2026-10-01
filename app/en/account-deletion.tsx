import Head from 'expo-router/head';
import { useEffect } from 'react';

import { AccountDeletionPage } from '@/components/AccountDeletionPage';

export default function EnglishAccountDeletionScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'en');
      document.title = 'OISINT | Account deletion';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | Account deletion</title>
        <meta name="description" content="Review how to delete an OISINT account and personal data, what is deleted, and what retention periods apply." />
      </Head>
      <AccountDeletionPage locale="en" title="Delete your account and personal data" />
    </>
  );
}
