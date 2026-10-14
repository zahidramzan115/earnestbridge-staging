'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

type NotificationType =
  | 'application_alert' |'deadline_reminder' |'required_action' |'system_message' |'admin_note' |'document_decision' |'status_change';

interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  actionUrl?: string | null;
  actionLabel?: string | null;
  createdAt: string;
  metadata?: Record<string, any> | null;
}

const TYPE_CONFIG: Record<
  NotificationType,
  { label: string; icon: string; iconColor: string; bgColor: string; dotColor: string }
> = {
  admin_note: {
    label: 'Admin Note',
    icon: 'ChatBubbleLeftEllipsisIcon',
    iconColor: 'text-violet-600',
    bgColor: 'bg-violet-50',
    dotColor: 'bg-violet-500',
  },
  document_decision: {
    label: 'Document Decision',
    icon: 'ClipboardDocumentCheckIcon',
    iconColor: 'text-teal-600',
    bgColor: 'bg-teal-50',
    dotColor: 'bg-teal-500',
  },
  status_change: {
    label: 'Status Change',
    icon: 'ArrowPathRoundedSquareIcon',
    iconColor: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
    dotColor: 'bg-indigo-500',
  },
  application_alert: {
    label: 'Application Alert',
    icon: 'DocumentTextIcon',
    iconColor: 'text-blue-600',
    bgColor: 'bg-blue-50',
    dotColor: 'bg-blue-500',
  },
  deadline_reminder: {
    label: 'Deadline Reminder',
    icon: 'CalendarDaysIcon',
    iconColor: 'text-amber-600',
    bgColor: 'bg-amber-50',
    dotColor: 'bg-amber-500',
  },
  required_action: {
    label: 'Required Action',
    icon: 'ExclamationCircleIcon',
    iconColor: 'text-red-600',
    bgColor: 'bg-red-50',
    dotColor: 'bg-red-500',
  },
  system_message: {
    label: 'System Message',
    icon: 'InformationCircleIcon',
    iconColor: 'text-gray-500',
    bgColor: 'bg-gray-50',
    dotColor: 'bg-gray-400',
  },
};

const FILTER_TABS: { value: 'all' | 'unread' | NotificationType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'admin_note', label: 'Admin Notes' },
  { value: 'document_decision', label: 'Doc Decisions' },
  { value: 'status_change', label: 'Status Changes' },
];

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const diff = now - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function DashboardNotificationsPanel() {
  const { user } = useAuth();
  const supabase = createClient();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread' | NotificationType>('unread');

  const mapRow = (row: any): Notification => ({
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    message: row.message,
    isRead: row.is_read,
    actionUrl: row.action_url,
    actionLabel: row.action_label,
    createdAt: row.created_at,
    metadata: row.metadata ?? null,
  });

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(30);
      setNotifications((data || []).map(mapRow));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Real-time
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('dashboard-notif-panel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setNotifications((prev) => [mapRow(payload.new), ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as any;
            setNotifications((prev) =>
              prev.map((n) => (n.id === row.id ? { ...n, isRead: row.is_read } : n))
            );
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as any;
            setNotifications((prev) => prev.filter((n) => n.id !== row.id));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, supabase]);

  const markAsRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
    );
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user?.id);
  };

  const markAllAsRead = async () => {
    if (!user) return;
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (!unreadIds.length) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', unreadIds)
      .eq('user_id', user.id);
  };

  const filtered = notifications.filter((n) => {
    if (filter === 'all') return true;
    if (filter === 'unread') return !n.isRead;
    return n.type === filter;
  });

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col h-full">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Icon name="BellIcon" size={16} className="text-gray-500" />
          <h2 className="font-display text-sm font-700 text-gray-900">Notifications</h2>
          {unreadCount > 0 && (
            <span className="bg-eb-gold-500 text-white text-[10px] font-700 font-display px-1.5 py-0.5 rounded-full leading-none">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={markAllAsRead}
              className="text-[11px] font-600 text-gray-400 hover:text-eb-green-700 transition-colors"
            >
              Mark all read
            </button>
          )}
          <Link
            href="/notifications"
            className="text-[11px] font-600 text-eb-green-700 hover:text-eb-green-900 transition-colors"
          >
            View all →
          </Link>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-4 py-2.5 border-b border-gray-100 overflow-x-auto scrollbar-hide">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-600 font-display transition-all ${
              filter === tab.value
                ? 'bg-eb-green-900 text-white' :'text-gray-500 hover:bg-gray-100'
            }`}
          >
            {tab.label}
            {tab.value === 'unread' && unreadCount > 0 && (
              <span className={`ml-1 text-[10px] font-700 ${filter === 'unread' ? 'text-white/80' : 'text-eb-gold-600'}`}>
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
        {loading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-8 h-8 bg-gray-100 rounded-lg flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-gray-100 rounded w-3/4" />
                  <div className="h-2.5 bg-gray-100 rounded w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <Icon name="BellSlashIcon" size={28} className="text-gray-200 mb-2" />
            <p className="text-xs text-gray-400">
              {filter === 'unread' ? "You're all caught up!" : 'No notifications found'}
            </p>
          </div>
        ) : (
          filtered.slice(0, 10).map((notif) => {
            const config = TYPE_CONFIG[notif.type] ?? TYPE_CONFIG['system_message'];
            return (
              <div
                key={notif.id}
                className={`flex gap-3 px-4 py-3 transition-colors ${
                  notif.isRead ? 'opacity-70' : 'bg-gray-50/50'
                }`}
              >
                {/* Icon */}
                <div
                  className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${config.bgColor}`}
                >
                  <Icon
                    name={config.icon as Parameters<typeof Icon>[0]['name']}
                    size={15}
                    className={config.iconColor}
                  />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className={`text-[9px] font-700 font-display uppercase tracking-wide ${config.iconColor}`}>
                          {config.label}
                        </span>
                        {!notif.isRead && (
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${config.dotColor}`} />
                        )}
                        {/* Document decision outcome */}
                        {notif.type === 'document_decision' && notif.metadata?.decision && (
                          <span
                            className={`text-[9px] font-700 px-1 py-0.5 rounded ${
                              notif.metadata.decision === 'approved' ?'bg-emerald-100 text-emerald-700'
                                : notif.metadata.decision === 'rejected' ?'bg-red-100 text-red-700' :'bg-amber-100 text-amber-700'
                            }`}
                          >
                            {notif.metadata.decision === 'approved' ?'Approved'
                              : notif.metadata.decision === 'rejected' ?'Action Required' :'Flagged'}
                          </span>
                        )}
                        {/* Status change */}
                        {notif.type === 'status_change' && notif.metadata?.new_status && (
                          <span className="text-[9px] font-700 px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">
                            {notif.metadata.new_status.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
                          </span>
                        )}
                      </div>
                      <p className={`text-xs font-600 truncate ${notif.isRead ? 'text-gray-500' : 'text-gray-800'}`}>
                        {notif.title}
                      </p>
                      <p className="text-[11px] text-gray-400 line-clamp-1 mt-0.5">{notif.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-gray-300">{timeAgo(notif.createdAt)}</span>
                        {notif.actionUrl && notif.actionLabel && (
                          <a
                            href={notif.actionUrl}
                            onClick={() => !notif.isRead && markAsRead(notif.id)}
                            className="text-[10px] font-600 text-eb-green-700 hover:text-eb-green-900 underline underline-offset-1"
                          >
                            {notif.actionLabel}
                          </a>
                        )}
                        {!notif.isRead && (
                          <button
                            onClick={() => markAsRead(notif.id)}
                            className="text-[10px] text-gray-300 hover:text-eb-green-600 transition-colors"
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {!loading && filtered.length > 10 && (
        <div className="px-4 py-2.5 border-t border-gray-100 text-center">
          <Link
            href="/notifications"
            className="text-[11px] font-600 text-eb-green-700 hover:text-eb-green-900"
          >
            View {filtered.length - 10} more →
          </Link>
        </div>
      )}
    </div>
  );
}
