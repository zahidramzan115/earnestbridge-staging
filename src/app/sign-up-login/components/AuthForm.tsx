'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AuthForm() {
  const router = useRouter();

  useEffect(() => {
    router?.replace('/login');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-500">Redirecting to sign in…</p>
      </div>
    </div>
  );
}