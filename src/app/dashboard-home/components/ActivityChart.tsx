'use client';
import React, { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface WeekData {
  week: string;
  applications: number;
  funded: number;
}

function buildWeeks(apps: { created_at: string; app_status: string; submitted_at: string | null }[]): WeekData[] {
  const now = new Date();
  const weeks: WeekData[] = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(now);
    end.setDate(now.getDate() - i * 7);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const month = start.toLocaleString('en-US', { month: 'short' });
    const label = `${month} ${start.getDate()}`;
    const applications = apps.filter((a) => {
      const d = new Date(a.created_at);
      return d >= start && d <= end;
    }).length;
    const funded = apps.filter((a) => {
      if (!['funded', 'closed'].includes(a.app_status)) return false;
      const d = new Date(a.submitted_at || a.created_at);
      return d >= start && d <= end;
    }).length;
    weeks.push({ week: label, applications, funded });
  }
  return weeks;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-white rounded-xl shadow-modal border border-gray-100 px-4 py-3 text-sm">
      <p className="font-display font-600 text-gray-800 mb-2">{label}</p>
      {payload.map((p, i) => (
        <div key={`tt-${i}`} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-gray-500 capitalize">{p.name === 'applications' ? 'New Applications' : 'Deals Funded'}:</span>
          <span className="font-600 text-gray-900 tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ActivityChart() {
  const { user } = useAuth();
  const [chartData, setChartData] = useState<WeekData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setChartData(buildWeeks([]));
      setLoading(false);
      return;
    }
    const supabase = createClient();
    supabase
      .from('borrower_applications')
      .select('created_at, app_status, submitted_at')
      .eq('user_id', user.id)
      .then(({ data }) => {
        setChartData(buildWeeks(data || []));
        setLoading(false);
      });
  }, [user]);

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-6">
        <div className="animate-pulse h-[220px] bg-gray-100 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 sm:mb-6">
        <div>
          <h3 className="font-display font-600 text-gray-900 text-base">Application Activity</h3>
          <p className="text-xs text-gray-400 mt-0.5">New applications vs. funded deals — last 12 weeks</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-eb-green-700 opacity-80" />
            <span className="text-gray-500">Applications</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-eb-gold-500 opacity-80" />
            <span className="text-gray-500">Funded</span>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180} className="sm:!h-[220px]">
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="gradApplications" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0D2B1F" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#0D2B1F" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradFunded" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#C9A84C" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#C9A84C" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#9ca3af', fontFamily: 'DM Sans' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#9ca3af', fontFamily: 'DM Sans' }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey="applications" stroke="#0D2B1F" strokeWidth={2} fill="url(#gradApplications)" dot={false} activeDot={{ r: 4, fill: '#0D2B1F' }} />
          <Area type="monotone" dataKey="funded" stroke="#C9A84C" strokeWidth={2} fill="url(#gradFunded)" dot={false} activeDot={{ r: 4, fill: '#C9A84C' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}