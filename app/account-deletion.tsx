import Head from 'expo-router/head';
import { useEffect } from 'react';

import { AccountDeletionPage } from '@/components/AccountDeletionPage';

export default function AccountDeletionScreen() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', 'ja');
      document.title = 'OISINT | アカウント削除';
    }
  }, []);

  return (
    <>
      <Head>
        <title>OISINT | アカウント削除</title>
        <meta name="description" content="OISINT（美味しント）のアカウントと個人データの削除方法、削除対象、保持期間を確認できます。" />
      </Head>
      <AccountDeletionPage title="アカウントと個人データを削除" />
    </>
  );
}
