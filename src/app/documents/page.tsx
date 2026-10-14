'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import DocumentsContent from './components/DocumentsContent';

export default function DocumentsPage() {
  return (
    <AppLayout activePath="/documents">
      <DocumentsContent />
    </AppLayout>
  );
}
