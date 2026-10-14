'use client';
import React, { useEffect, useState, useRef } from 'react';
import Icon from '@/components/ui/AppIcon';
import { MOCK_ACTIVITY, ActivityEvent } from '@/lib/mockData';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface ActivityFeedProps {
  applicationId?: string;
}

type EventType = 'status_change' | 'document_upload' | 'admin_note' | 'deadline_shift' | 'system' | string;

interface FeedEvent {
  id: string;
  applicationId: string;
  dealName: string;
  event: string;
  detail: string;
  timestamp: string;
  actor: string;
  eventType?: EventType;
}

interface NoteReply {
  id: string;
  activity_id: string;
  application_id: string;
  user_id: string;
  actor: string;
  body: string;
  created_at: string;
}

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  'Application Approved':        { icon: 'CheckCircleIcon',         color: 'text-emerald-500 bg-emerald-50' },
  'Conditional Approval Issued': { icon: 'CheckBadgeIcon',          color: 'text-purple-500 bg-purple-50' },
  'Documents Requested':         { icon: 'DocumentArrowDownIcon',   color: 'text-amber-500 bg-amber-50' },
  'Document Uploaded':           { icon: 'ArrowUpTrayIcon',         color: 'text-blue-500 bg-blue-50' },
  'Review In Progress':          { icon: 'MagnifyingGlassIcon',     color: 'text-blue-500 bg-blue-50' },
  'Application Submitted':       { icon: 'PaperAirplaneIcon',       color: 'text-blue-400 bg-blue-50' },
  'EMD Funded':                  { icon: 'BanknotesIcon',           color: 'text-eb-green-700 bg-eb-green-50' },
  'Deal Closed':                 { icon: 'BuildingOffice2Icon',     color: 'text-gray-600 bg-gray-100' },
  'Draft Application Created':   { icon: 'PencilSquareIcon',        color: 'text-gray-400 bg-gray-50' },
  'Status Changed':              { icon: 'ArrowPathIcon',           color: 'text-indigo-500 bg-indigo-50' },
  'Admin Note Added':            { icon: 'ChatBubbleLeftEllipsisIcon', color: 'text-violet-500 bg-violet-50' },
  'Deadline Updated':            { icon: 'CalendarDaysIcon',        color: 'text-orange-500 bg-orange-50' },
};

const EVENT_TYPE_ICONS: Record<EventType, { icon: string; color: string }> = {
  status_change:   { icon: 'ArrowPathIcon',              color: 'text-indigo-500 bg-indigo-50' },
  document_upload: { icon: 'ArrowUpTrayIcon',            color: 'text-blue-500 bg-blue-50' },
  admin_note:      { icon: 'ChatBubbleLeftEllipsisIcon', color: 'text-violet-500 bg-violet-50' },
  deadline_shift:  { icon: 'CalendarDaysIcon',           color: 'text-orange-500 bg-orange-50' },
  system:          { icon: 'InformationCircleIcon',      color: 'text-gray-400 bg-gray-50' },
};

function timeAgo(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffDays > 30) return `${Math.floor(diffDays / 30)}mo ago`;
  if (diffDays > 1) return `${diffDays}d ago`;
  if (diffDays === 1) return '1d ago';
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'Just now';
}

function formatTimestamp(timestamp: string): string {
  const d = new Date(timestamp);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function getIconConfig(event: FeedEvent): { icon: string; color: string } {
  if (event.eventType && EVENT_TYPE_ICONS[event.eventType]) {
    return EVENT_TYPE_ICONS[event.eventType];
  }
  return EVENT_ICONS[event.event] ?? { icon: 'InformationCircleIcon', color: 'text-gray-400 bg-gray-50' };
}

const FILTER_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Status', value: 'status_change' },
  { label: 'Documents', value: 'document_upload' },
  { label: 'Notes', value: 'admin_note' },
  { label: 'Deadlines', value: 'deadline_shift' },
];

// ── Inline Reply Thread Component ──────────────────────────────────────────
interface NoteReplyThreadProps {
  eventId: string;
  applicationId: string;
  actorName: string;
}

function NoteReplyThread({ eventId, applicationId, actorName }: NoteReplyThreadProps) {
  const { user } = useAuth();
  const [replies, setReplies] = useState<NoteReply[]>([]);
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load replies when thread is opened
  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    supabase
      .from('deal_note_replies')
      .select('*')
      .eq('activity_id', eventId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (data) setReplies(data as NoteReply[]);
      });

    // Real-time subscription for new replies
    const channel = supabase
      .channel(`replies-${eventId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'deal_note_replies',
        filter: `activity_id=eq.${eventId}`,
      }, (payload) => {
        setReplies((prev) => {
          const exists = prev.some((r) => r.id === (payload.new as NoteReply).id);
          return exists ? prev : [...prev, payload.new as NoteReply];
        });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [open, eventId]);

  async function handleSubmitReply() {
    if (!replyText.trim() || !user) return;
    setSubmitting(true);
    const supabase = createClient();
    const optimisticReply: NoteReply = {
      id: `opt-${Date.now()}`,
      activity_id: eventId,
      application_id: applicationId,
      user_id: user.id,
      actor: user.email ?? 'Borrower',
      body: replyText.trim(),
      created_at: new Date().toISOString(),
    };
    setReplies((prev) => [...prev, optimisticReply]);
    setReplyText('');

    try {
      await supabase.from('deal_note_replies').insert({
        activity_id: eventId,
        application_id: applicationId,
        user_id: user.id,
        actor: user.email ?? 'Borrower',
        body: optimisticReply.body,
      });
    } catch {
      // optimistic reply stays visible
    } finally {
      setSubmitting(false);
    }
  }

  const replyCount = replies.length;

  return (
    <div className="mt-2">
      {/* Toggle replies button */}
      <button
        onClick={() => { setOpen((v) => !v); if (!open) setTimeout(() => textareaRef.current?.focus(), 150); }}
        className="flex items-center gap-1.5 text-[11px] text-violet-600 hover:text-violet-800 font-display font-600 transition-colors"
      >
        <Icon name="ChatBubbleOvalLeftIcon" size={12} />
        {open
          ? 'Hide replies'
          : replyCount > 0
          ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`
          : 'Reply'}
        {!open && replyCount === 0 && (
          <span className="text-gray-400 font-400">· ask a question</span>
        )}
      </button>

      {open && (
        <div className="mt-2 pl-3 border-l-2 border-violet-100 space-y-2">
          {/* Existing replies */}
          {replies.map((r) => (
            <div key={r.id} className="flex gap-2 items-start">
              <div className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon name="UserIcon" size={10} className="text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-display font-600 text-gray-700 truncate max-w-[140px]">{r.actor}</span>
                  <span className="text-[10px] text-gray-400">{timeAgo(r.created_at)}</span>
                </div>
                <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{r.body}</p>
              </div>
            </div>
          ))}

          {/* Reply input */}
          {user && (
            <div className="flex gap-2 items-end pt-1">
              <textarea
                ref={textareaRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitReply();
                  }
                }}
                placeholder={`Reply to ${actorName}…`}
                rows={1}
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 resize-none transition-all"
              />
              <button
                onClick={handleSubmitReply}
                disabled={!replyText.trim() || submitting}
                className="px-3 py-1.5 bg-violet-600 text-white text-[11px] font-display font-600 rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0 min-h-[32px]"
              >
                {submitting ? (
                  <Icon name="ArrowPathIcon" size={11} className="animate-spin" />
                ) : (
                  'Send'
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ActivityFeed ──────────────────────────────────────────────────────
export default function ActivityFeed({ applicationId }: ActivityFeedProps) {
  const { user } = useAuth();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [isLive, setIsLive] = useState(false);
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null);

  // Load real activity from Supabase; fall back to mock data only for mock IDs
  useEffect(() => {
    if (!user) return;

    // Mock IDs (from mockData.ts) — show mock activity for demo purposes
    const isMockId = applicationId?.startsWith('app-');
    if (isMockId) {
      const base: FeedEvent[] = MOCK_ACTIVITY
        .filter((e: ActivityEvent) => !applicationId || e.applicationId === applicationId)
        .map((e: ActivityEvent) => ({ ...e, eventType: 'system' }));
      setEvents(base);
      return;
    }

    const supabase = createClient();
    const query = supabase
      .from('application_activity')
      .select('*')
      .order('created_at', { ascending: false });

    if (applicationId) {
      query.eq('application_id', applicationId);
    } else {
      // Load all activity for this user's applications
      query.eq('user_id', user.id);
    }

    query.then(({ data }) => {
      if (data && data.length > 0) {
        const mapped: FeedEvent[] = data.map((row: any) => ({
          id: row.id,
          applicationId: row.application_id,
          dealName: row.metadata?.dealName ?? row.application_id,
          event: row.title,
          detail: row.detail ?? '',
          timestamp: row.created_at,
          actor: row.actor,
          eventType: row.event_type,
        }));
        setEvents(mapped);
      } else {
        // No activity yet — show empty state (not mock data)
        setEvents([]);
      }
    }).catch(() => {
      setEvents([]);
    });
  }, [user, applicationId]);

  // Real-time subscription to application_activity table
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`activity-feed-${applicationId ?? 'all'}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'application_activity',
          filter: applicationId ? `application_id=eq.${applicationId}` : undefined,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            application_id: string;
            event_type: EventType;
            title: string;
            detail: string;
            actor: string;
            created_at: string;
            metadata?: { dealName?: string };
          };
          const newEvent: FeedEvent = {
            id: row.id,
            applicationId: row.application_id,
            dealName: row.metadata?.dealName ?? row.application_id,
            event: row.title,
            detail: row.detail ?? '',
            timestamp: row.created_at,
            actor: row.actor,
            eventType: row.event_type,
          };
          setEvents((prev) => [newEvent, ...prev]);
          setNewEventIds((prev) => new Set([...prev, row.id]));
          setTimeout(() => {
            setNewEventIds((prev) => {
              const next = new Set(prev);
              next.delete(row.id);
              return next;
            });
          }, 4000);
        }
      )
      .subscribe((status) => {
        setIsLive(status === 'SUBSCRIBED');
      });

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [user, applicationId]);

  const filtered = events.filter((e) => {
    if (filter === 'all') return true;
    return e.eventType === filter;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-display font-600 text-gray-900 text-sm">
              {applicationId ? 'Deal Activity' : 'All Activity'}
            </h3>
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'}`} />
              <span className="text-[11px] text-gray-400">{isLive ? 'Live' : 'Connecting…'}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{filtered.length} event{filtered.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={`filter-${opt.value}`}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 text-xs font-display font-600 rounded-full border transition-all min-h-[28px] ${
              filter === opt.value
                ? 'bg-eb-green-900 text-white border-eb-green-900' :'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40 hover:text-eb-green-900'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-12 h-12 rounded-2xl bg-gray-50 flex items-center justify-center mb-3">
            <Icon name="ClockIcon" size={24} className="text-gray-300" />
          </div>
          <p className="font-display font-600 text-gray-500 text-sm">No activity yet</p>
          <p className="text-xs text-gray-400 mt-1">Events will appear here as your application progresses.</p>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-100" />
          <div className="space-y-0">
            {filtered.map((evt, i) => {
              const cfg = getIconConfig(evt);
              const isNew = newEventIds.has(evt.id);
              const isAdminNote = evt.eventType === 'admin_note';
              return (
                <div
                  key={`evt-${evt.id}-${i}`}
                  className={`relative flex gap-4 pl-0 transition-all duration-500 ${isNew ? 'bg-emerald-50/60 rounded-xl' : ''}`}
                >
                  {/* Icon dot */}
                  <div className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 ${cfg.color} border border-white shadow-sm`}>
                    <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={14} />
                  </div>
                  <div className="flex-1 min-w-0 pb-4 border-b border-gray-50 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-gray-900">{evt.event}</p>
                          {isNew && (
                            <span className="text-[10px] text-emerald-600 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded-full font-display font-600">
                              New
                            </span>
                          )}
                          {isAdminNote && (
                            <span className="text-[10px] text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-full font-display font-600">
                              Admin Note
                            </span>
                          )}
                        </div>
                        {evt.detail && (
                          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{evt.detail}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {!applicationId && (
                            <>
                              <span className="text-[11px] text-gray-500 font-medium truncate max-w-[140px]">{evt.dealName}</span>
                              <span className="text-gray-200">·</span>
                            </>
                          )}
                          <span className="text-[11px] text-gray-400">{evt.actor}</span>
                        </div>

                        {/* Inline reply thread — only for admin notes */}
                        {isAdminNote && applicationId && (
                          <NoteReplyThread
                            eventId={evt.id}
                            applicationId={applicationId}
                            actorName={evt.actor}
                          />
                        )}
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <span className="text-[11px] text-gray-400 whitespace-nowrap tabular-nums">{timeAgo(evt.timestamp)}</span>
                        <p className="text-[10px] text-gray-300 mt-0.5 whitespace-nowrap hidden sm:block">{formatTimestamp(evt.timestamp)}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}