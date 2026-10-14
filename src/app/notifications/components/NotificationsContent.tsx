'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import Icon from '@/components/ui/AppIcon';

type NotificationType =
  | 'application_alert' |'deadline_reminder' |'required_action' |'system_message' |'admin_note' |'document_decision' |'status_change';

interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  actionUrl?: string | null;
  actionLabel?: string | null;
  createdAt: string;
  readAt?: string | null;
  metadata?: Record<string, any> | null;
}

const TYPE_CONFIG: Record<
  NotificationType,
  { label: string; icon: string; iconColor: string; bgColor: string; borderColor: string }
> = {
  application_alert: {
    label: 'Application Alert',
    icon: 'DocumentTextIcon',
    iconColor: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  deadline_reminder: {
    label: 'Deadline Reminder',
    icon: 'CalendarDaysIcon',
    iconColor: 'text-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
  },
  required_action: {
    label: 'Required Action',
    icon: 'ExclamationCircleIcon',
    iconColor: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
  },
  system_message: {
    label: 'System Message',
    icon: 'InformationCircleIcon',
    iconColor: 'text-eb-green-600',
    bgColor: 'bg-eb-green-50',
    borderColor: 'border-eb-green-200',
  },
  admin_note: {
    label: 'Admin Note',
    icon: 'ChatBubbleLeftEllipsisIcon',
    iconColor: 'text-violet-600',
    bgColor: 'bg-violet-50',
    borderColor: 'border-violet-300',
  },
  document_decision: {
    label: 'Document Decision',
    icon: 'ClipboardDocumentCheckIcon',
    iconColor: 'text-teal-600',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-300',
  },
  status_change: {
    label: 'Status Change',
    icon: 'ArrowPathRoundedSquareIcon',
    iconColor: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
    borderColor: 'border-indigo-300',
  },
};

const FILTER_OPTIONS: { value: 'all' | 'unread' | NotificationType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'admin_note', label: 'Admin Notes' },
  { value: 'document_decision', label: 'Document Decisions' },
  { value: 'status_change', label: 'Status Changes' },
  { value: 'application_alert', label: 'Application Alerts' },
  { value: 'deadline_reminder', label: 'Deadline Reminders' },
  { value: 'required_action', label: 'Required Actions' },
  { value: 'system_message', label: 'System Messages' },
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

/** Small pill showing document decision outcome */
function DocumentDecisionPill({ decision }: { decision?: string }) {
  if (!decision) return null;
  const map: Record<string, { label: string; cls: string }> = {
    approved: { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' },
    rejected: { label: 'Action Required', cls: 'bg-red-100 text-red-700' },
    flagged: { label: 'Flagged', cls: 'bg-amber-100 text-amber-700' },
  };
  const cfg = map[decision] ?? { label: decision, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`text-[10px] font-700 font-display px-1.5 py-0.5 rounded ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

/** Small pill showing old → new status */
function StatusChangePill({ oldStatus, newStatus }: { oldStatus?: string; newStatus?: string }) {
  if (!newStatus) return null;
  const fmt = (s: string) =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-600 font-display text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded">
      {oldStatus && <span className="text-gray-400">{fmt(oldStatus)}</span>}
      {oldStatus && <Icon name="ArrowRightIcon" size={10} className="text-indigo-400" />}
      <span>{fmt(newStatus)}</span>
    </span>
  );
}

export default function NotificationsContent() {
  const { user } = useAuth();
  const supabase = createClient();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread' | NotificationType>('all');
  const [markingAllRead, setMarkingAllRead] = useState(false);

  const mapRow = (row: any): Notification => ({
    id: row.id,
    userId: row.user_id,
    type: row.type as NotificationType,
    title: row.title,
    message: row.message,
    isRead: row.is_read,
    actionUrl: row.action_url,
    actionLabel: row.action_label,
    createdAt: row.created_at,
    readAt: row.read_at,
    metadata: row.metadata ?? null,
  });

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setNotifications((data || []).map(mapRow));
    } catch (err: any) {
      setError(err?.message || 'Failed to load notifications.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // ── Real-time subscription ─────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('notifications-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setNotifications((prev) => [mapRow(payload.new), ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as any;
            setNotifications((prev) =>
              prev.map((n) =>
                n.id === row.id
                  ? { ...n, isRead: row.is_read, readAt: row.read_at, title: row.title, message: row.message }
                  : n
              )
            );
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as any;
            setNotifications((prev) => prev.filter((n) => n.id !== row.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, supabase]);

  const markAsRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n))
    );
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user?.id);
  };

  const markAsUnread = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: false, readAt: null } : n))
    );
    await supabase
      .from('notifications')
      .update({ is_read: false, read_at: null })
      .eq('id', id)
      .eq('user_id', user?.id);
  };

  const markAllAsRead = async () => {
    if (!user) return;
    setMarkingAllRead(true);
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length === 0) {
      setMarkingAllRead(false);
      return;
    }
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() }))
    );
    await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', unreadIds)
      .eq('user_id', user.id);
    setMarkingAllRead(false);
  };

  const deleteNotification = async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    await supabase.from('notifications').delete().eq('id', id).eq('user_id', user?.id);
  };

  const filtered = notifications.filter((n) => {
    if (filter === 'all') return true;
    if (filter === 'unread') return !n.isRead;
    return n.type === filter;
  });

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  // Counts per new type for the summary strip
  const adminNoteCount = notifications.filter((n) => n.type === 'admin_note' && !n.isRead).length;
  const docDecisionCount = notifications.filter((n) => n.type === 'document_decision' && !n.isRead).length;
  const statusChangeCount = notifications.filter((n) => n.type === 'status_change' && !n.isRead).length;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-700 text-gray-900">Notifications</h1>
            {unreadCount > 0 && (
              <span className="bg-eb-gold-500 text-white text-xs font-700 font-display px-2 py-0.5 rounded-full">
                {unreadCount}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-0.5">
            Stay updated on admin notes, document decisions, status changes, and deadlines.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            disabled={markingAllRead}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all active:scale-95 disabled:opacity-50"
          >
            <Icon name="CheckCircleIcon" size={14} />
            <span>{markingAllRead ? 'Marking...' : 'Mark all as read'}</span>
          </button>
        )}
      </div>

      {/* Unread summary strip for the 3 key borrower types */}
      {!loading && (adminNoteCount > 0 || docDecisionCount > 0 || statusChangeCount > 0) && (
        <div className="grid grid-cols-3 gap-3 mb-5">
          <button
            onClick={() => setFilter('admin_note')}
            className={`flex items-center gap-2 p-3 rounded-xl border transition-all text-left ${
              filter === 'admin_note' ?'bg-violet-600 border-violet-600 text-white' :'bg-white border-gray-200 hover:border-violet-300 hover:bg-violet-50'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${filter === 'admin_note' ? 'bg-white/20' : 'bg-violet-100'}`}>
              <Icon name="ChatBubbleLeftEllipsisIcon" size={16} className={filter === 'admin_note' ? 'text-white' : 'text-violet-600'} />
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-600 font-display truncate ${filter === 'admin_note' ? 'text-white' : 'text-gray-700'}`}>Admin Notes</p>
              <p className={`text-lg font-700 font-display leading-none mt-0.5 ${filter === 'admin_note' ? 'text-white' : 'text-violet-700'}`}>{adminNoteCount}</p>
            </div>
          </button>

          <button
            onClick={() => setFilter('document_decision')}
            className={`flex items-center gap-2 p-3 rounded-xl border transition-all text-left ${
              filter === 'document_decision'
                ? 'bg-teal-600 border-teal-600 text-white' :'bg-white border-gray-200 hover:border-teal-300 hover:bg-teal-50'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${filter === 'document_decision' ? 'bg-white/20' : 'bg-teal-100'}`}>
              <Icon name="ClipboardDocumentCheckIcon" size={16} className={filter === 'document_decision' ? 'text-white' : 'text-teal-600'} />
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-600 font-display truncate ${filter === 'document_decision' ? 'text-white' : 'text-gray-700'}`}>Doc Decisions</p>
              <p className={`text-lg font-700 font-display leading-none mt-0.5 ${filter === 'document_decision' ? 'text-white' : 'text-teal-700'}`}>{docDecisionCount}</p>
            </div>
          </button>

          <button
            onClick={() => setFilter('status_change')}
            className={`flex items-center gap-2 p-3 rounded-xl border transition-all text-left ${
              filter === 'status_change' ?'bg-indigo-600 border-indigo-600 text-white' :'bg-white border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${filter === 'status_change' ? 'bg-white/20' : 'bg-indigo-100'}`}>
              <Icon name="ArrowPathRoundedSquareIcon" size={16} className={filter === 'status_change' ? 'text-white' : 'text-indigo-600'} />
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-600 font-display truncate ${filter === 'status_change' ? 'text-white' : 'text-gray-700'}`}>Status Changes</p>
              <p className={`text-lg font-700 font-display leading-none mt-0.5 ${filter === 'status_change' ? 'text-white' : 'text-indigo-700'}`}>{statusChangeCount}</p>
            </div>
          </button>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-1.5 flex-wrap mb-5">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-600 font-display transition-all ${
              filter === opt.value
                ? 'bg-eb-green-900 text-white' :'bg-white text-gray-600 border border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            {opt.label}
            {opt.value === 'unread' && unreadCount > 0 && (
              <span
                className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-700 ${
                  filter === 'unread' ? 'bg-white/20 text-white' : 'bg-eb-gold-100 text-eb-gold-700'
                }`}
              >
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="flex gap-3">
                <div className="w-9 h-9 bg-gray-100 rounded-lg flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-100 rounded w-2/3" />
                  <div className="h-3 bg-gray-100 rounded w-full" />
                  <div className="h-3 bg-gray-100 rounded w-1/2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <Icon name="ExclamationCircleIcon" size={32} className="text-red-400 mx-auto mb-2" />
          <p className="text-sm text-red-600 font-medium">{error}</p>
          <button
            onClick={fetchNotifications}
            className="mt-3 text-xs text-red-500 underline hover:text-red-700"
          >
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl p-12 text-center">
          <Icon name="BellSlashIcon" size={40} className="text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">
            {filter === 'unread' ? 'No unread notifications' : 'No notifications found'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {filter === 'unread' ? "You're all caught up!" :'Notifications will appear here as your application progresses.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((notif) => {
            const config = TYPE_CONFIG[notif.type] ?? TYPE_CONFIG['system_message'];
            return (
              <div
                key={notif.id}
                className={`group relative bg-white rounded-xl border transition-all duration-150 ${
                  notif.isRead
                    ? 'border-gray-100 opacity-80'
                    : `border-l-4 ${config.borderColor} border-r border-t border-b border-r-gray-100 border-t-gray-100 border-b-gray-100 shadow-sm`
                }`}
              >
                <div className="flex gap-3 p-4">
                  {/* Icon */}
                  <div
                    className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${config.bgColor}`}
                  >
                    <Icon
                      name={config.icon as Parameters<typeof Icon>[0]['name']}
                      size={18}
                      className={config.iconColor}
                    />
                  </div>

                  {/* Body */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`text-[10px] font-600 font-display uppercase tracking-wide px-1.5 py-0.5 rounded ${config.bgColor} ${config.iconColor}`}
                          >
                            {config.label}
                          </span>
                          {!notif.isRead && (
                            <span className="w-2 h-2 bg-eb-gold-500 rounded-full flex-shrink-0" />
                          )}
                          {/* Document decision outcome pill */}
                          {notif.type === 'document_decision' && notif.metadata?.decision && (
                            <DocumentDecisionPill decision={notif.metadata.decision} />
                          )}
                          {/* Status change pill */}
                          {notif.type === 'status_change' && notif.metadata?.new_status && (
                            <StatusChangePill
                              oldStatus={notif.metadata.old_status}
                              newStatus={notif.metadata.new_status}
                            />
                          )}
                        </div>
                        <h3
                          className={`mt-1 text-sm font-600 truncate ${
                            notif.isRead ? 'text-gray-600' : 'text-gray-900'
                          }`}
                        >
                          {notif.title}
                        </h3>
                        <p className="mt-0.5 text-xs text-gray-500 leading-relaxed line-clamp-2">
                          {notif.message}
                        </p>
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          <span className="text-[11px] text-gray-400">{timeAgo(notif.createdAt)}</span>
                          {notif.actionUrl && notif.actionLabel && (
                            <a
                              href={notif.actionUrl}
                              onClick={() => !notif.isRead && markAsRead(notif.id)}
                              className="text-[11px] font-600 text-eb-green-700 hover:text-eb-green-900 underline underline-offset-2 transition-colors"
                            >
                              {notif.actionLabel} →
                            </a>
                          )}
                          {/* Inline mark-as-read for unread items */}
                          {!notif.isRead && (
                            <button
                              onClick={() => markAsRead(notif.id)}
                              className="text-[11px] font-600 text-gray-400 hover:text-eb-green-700 transition-colors"
                            >
                              Mark as read
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Hover actions */}
                      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        {notif.isRead ? (
                          <button
                            onClick={() => markAsUnread(notif.id)}
                            title="Mark as unread"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                          >
                            <Icon name="EnvelopeIcon" size={14} />
                          </button>
                        ) : (
                          <button
                            onClick={() => markAsRead(notif.id)}
                            title="Mark as read"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-eb-green-600 hover:bg-eb-green-50 transition-all"
                          >
                            <Icon name="CheckIcon" size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => deleteNotification(notif.id)}
                          title="Dismiss"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all"
                        >
                          <Icon name="XMarkIcon" size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary footer */}
      {!loading && !error && notifications.length > 0 && (
        <p className="text-center text-xs text-gray-400 mt-6">
          Showing {filtered.length} of {notifications.length} notification
          {notifications.length !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}
