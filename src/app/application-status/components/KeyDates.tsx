import React from 'react';
import Icon from '@/components/ui/AppIcon';
import { EMDApplication } from '@/lib/mockData';

interface KeyDatesProps {
  application: EMDApplication;
}

function formatDate(dateStr: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export default function KeyDates({ application }: KeyDatesProps) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 space-y-5">
      <h3 className="font-display font-600 text-gray-900">Key Dates</h3>

      <div className="space-y-3">
        {/* Submitted */}
        <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
            <Icon name="PaperAirplaneIcon" size={14} className="text-blue-500" />
          </div>
          <div>
            <p className="text-[11px] font-display font-600 uppercase tracking-wide text-gray-400">Application Submitted</p>
            <p className="text-sm font-medium text-gray-800 mt-0.5">{formatDate(application.submittedDate)}</p>
          </div>
        </div>

        {/* Funded date (if applicable) */}
        {application.fundedDate && (
          <div className="flex items-start gap-3 p-3 bg-eb-green-50 rounded-xl">
            <div className="w-8 h-8 rounded-lg bg-eb-green-100 flex items-center justify-center flex-shrink-0">
              <Icon name="BanknotesIcon" size={14} className="text-eb-green-700" />
            </div>
            <div>
              <p className="text-[11px] font-display font-600 uppercase tracking-wide text-eb-green-600">EMD Funded</p>
              <p className="text-sm font-medium text-eb-green-900 mt-0.5">{formatDate(application.fundedDate)}</p>
              {application.daysToFunding && (
                <p className="text-xs text-eb-green-600 mt-0.5">{application.daysToFunding} days from submission</p>
              )}
            </div>
          </div>
        )}

        {/* Target closing date (informational only) */}
        <div className="flex items-start gap-3 p-3 rounded-xl bg-gray-50">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-gray-100">
            <Icon name="CalendarDaysIcon" size={14} className="text-gray-500" />
          </div>
          <div>
            <p className="text-[11px] font-display font-600 uppercase tracking-wide text-gray-400">Target Closing Date</p>
            <p className="text-sm font-medium mt-0.5 text-gray-800">{formatDate(application.closingDate)}</p>
          </div>
        </div>
      </div>

      {/* Deal details */}
      <div className="border-t border-gray-100 pt-4 space-y-2.5">
        <p className="text-[11px] font-display font-600 uppercase tracking-widest text-gray-400 mb-3">Deal Details</p>
        {[
          { label: 'EMD Amount', value: `$${application.emdAmount.toLocaleString()}`, mono: true },
          { label: 'Purchase Price', value: `$${application.purchasePrice.toLocaleString()}`, mono: true },
          { label: 'Property Type', value: application.propertyType, mono: false },
          ...(application.lender ? [{ label: 'Lender', value: application.lender, mono: false }] : []),
        ].map((item, i) => (
          <div key={`kd-${i}`} className="flex items-center justify-between">
            <span className="text-xs text-gray-400">{item.label}</span>
            <span className={`text-xs font-medium text-gray-800 ${item.mono ? 'tabular-nums font-mono' : ''}`}>{item.value}</span>
          </div>
        ))}
      </div>

      {/* Action items count */}
      {application.actionItemsCount > 0 && (
        <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl border border-red-100">
          <Icon name="ExclamationTriangleIcon" size={16} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-700">{application.actionItemsCount} action item{application.actionItemsCount !== 1 ? 's' : ''} pending</p>
            <p className="text-xs text-red-500 mt-0.5">Upload documents or provide information to proceed</p>
          </div>
        </div>
      )}
    </div>
  );
}