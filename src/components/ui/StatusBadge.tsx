import React from 'react';
import { ApplicationStatus, STATUS_LABELS, STATUS_COLORS } from '@/lib/mockData';

interface StatusBadgeProps {
  status: ApplicationStatus;
  size?: 'sm' | 'md';
}

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const colorClass = STATUS_COLORS[status];
  const label = STATUS_LABELS[status];
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1';

  return (
    <span className={`inline-flex items-center font-medium rounded-full font-display ${colorClass} ${sizeClass} whitespace-nowrap`}>
      {label}
    </span>
  );
}