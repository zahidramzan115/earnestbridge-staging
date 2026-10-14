import React from 'react';
import AppLayout from '@/components/AppLayout';
import DeadlinesContent from './components/DeadlinesContent';
import Icon from '@/components/ui/AppIcon';

export default function DeadlinesPage() {
  return (
    <AppLayout activePath="/deadlines">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Icon name="CalendarDaysIcon" size={22} className="text-eb-green-700" />
          <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Deadlines</h1>
        </div>
        <p className="text-sm text-gray-400">Track your deal deadlines, action items, and closing dates.</p>
      </div>
      <DeadlinesContent />
    </AppLayout>
  );
}
