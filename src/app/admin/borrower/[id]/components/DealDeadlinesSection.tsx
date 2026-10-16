'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DealDeadline {
  id: string;
  application_id: string;
  title: string;
  deadline_type: 'emd_due' | 'document_due' | 'funding' | 'option' | 'inspection' | 'custom';
  due_date: string;
  responsible_party: 'client' | 'earnestbridge' | 'third_party';
  client_visible: boolean;
  status: 'open' | 'completed' | 'cancelled';
  notes: string | null;
  created_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

interface DealDeadlinesSectionProps {
  applicationId: string;
  closingDate: string | null;
  isMockId?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEADLINE_TYPE_LABELS: Record<DealDeadline['deadline_type'], string> = {
  emd_due: 'EMD Due',
  document_due: 'Document Due',
  funding: 'Funding',
  option: 'Option',
  inspection: 'Inspection',
  custom: 'Custom',
};

const RESPONSIBLE_PARTY_LABELS: Record<DealDeadline['responsible_party'], string> = {
  client: 'Client',
  earnestbridge: 'EarnestBridge',
  third_party: 'Third Party',
};

const RESPONSIBLE_PARTY_COLORS: Record<DealDeadline['responsible_party'], string> = {
  client: 'bg-blue-50 text-blue-700 border-blue-200',
  earnestbridge: 'bg-eb-green-50 text-eb-green-700 border-eb-green-200',
  third_party: 'bg-purple-50 text-purple-700 border-purple-200',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + 'T00:00:00');
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

type DerivedState = 'overdue' | 'due_today' | 'upcoming' | 'completed' | 'cancelled';

function getDerivedState(deadline: DealDeadline): DerivedState {
  if (deadline.status === 'completed') return 'completed';
  if (deadline.status === 'cancelled') return 'cancelled';
  const days = getDaysUntil(deadline.due_date);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due_today';
  return 'upcoming';
}

const DERIVED_STATE_CONFIG: Record<DerivedState, { label: string; color: string; bg: string; border: string; icon: string }> = {
  overdue:   { label: 'Overdue',    color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200',     icon: 'ExclamationCircleIcon' },
  due_today: { label: 'Due Today',  color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'ClockIcon' },
  upcoming:  { label: 'Upcoming',   color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'CalendarDaysIcon' },
  completed: { label: 'Completed',  color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckCircleIcon' },
  cancelled: { label: 'Cancelled',  color: 'text-gray-500',    bg: 'bg-gray-50',    border: 'border-gray-200',    icon: 'XCircleIcon' },
};

function sortDeadlines(deadlines: DealDeadline[]): DealDeadline[] {
  const order: Record<DerivedState, number> = { overdue: 0, due_today: 1, upcoming: 2, completed: 3, cancelled: 4 };
  return [...deadlines].sort((a, b) => {
    const stateA = getDerivedState(a);
    const stateB = getDerivedState(b);
    const orderDiff = order[stateA] - order[stateB];
    if (orderDiff !== 0) return orderDiff;
    return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
  });
}

// ── Mock data for demo IDs ────────────────────────────────────────────────────

const MOCK_DEADLINES: DealDeadline[] = [
  {
    id: 'mock-dl-1',
    application_id: 'demo',
    title: 'Signed PSA Due',
    deadline_type: 'document_due',
    due_date: new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0],
    responsible_party: 'client',
    client_visible: true,
    status: 'open',
    notes: 'Borrower confirmed PSA is being reviewed by attorney.',
    created_by: null,
    completed_at: null,
    completed_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'mock-dl-2',
    application_id: 'demo',
    title: 'EMD Due',
    deadline_type: 'emd_due',
    due_date: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0],
    responsible_party: 'client',
    client_visible: true,
    status: 'open',
    notes: null,
    created_by: null,
    completed_at: null,
    completed_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'mock-dl-3',
    application_id: 'demo',
    title: 'Internal File Review',
    deadline_type: 'custom',
    due_date: new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
    responsible_party: 'earnestbridge',
    client_visible: false,
    status: 'open',
    notes: 'Review all compliance docs before funding.',
    created_by: null,
    completed_at: null,
    completed_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// ── Deadline Form ─────────────────────────────────────────────────────────────

interface DeadlineFormData {
  title: string;
  deadline_type: DealDeadline['deadline_type'];
  due_date: string;
  responsible_party: DealDeadline['responsible_party'];
  client_visible: boolean;
  notes: string;
}

const EMPTY_FORM: DeadlineFormData = {
  title: '',
  deadline_type: 'custom',
  due_date: '',
  responsible_party: 'earnestbridge',
  client_visible: false,
  notes: '',
};

// ── Confirm Modal ─────────────────────────────────────────────────────────────

interface ConfirmAction {
  type: 'complete' | 'cancel' | 'reopen';
  deadline: DealDeadline;
}

// ── Main Component ────────────────────────────────────────────────────────────

const DealDeadlinesSection: React.FC<DealDeadlinesSectionProps> = ({
  applicationId,
  closingDate,
  isMockId = false,
}) => {
  const [deadlines, setDeadlines] = useState<DealDeadline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add/Edit modal
  const [showForm, setShowForm] = useState(false);
  const [editingDeadline, setEditingDeadline] = useState<DealDeadline | null>(null);
  const [form, setForm] = useState<DeadlineFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Confirm action modal
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirming, setConfirming] = useState(false);

  // ── Load deadlines ──────────────────────────────────────────────────────────

  const loadDeadlines = useCallback(async () => {
    if (isMockId) {
      setDeadlines(MOCK_DEADLINES);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let res = await fetch(`/api/admin/deadlines?application_id=${applicationId}`);
      if (!res.ok) throw new Error('Failed to load deadlines');
      const json = await res.json();
      setDeadlines(json.deadlines ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load deadlines');
    } finally {
      setLoading(false);
    }
  }, [applicationId, isMockId]);

  useEffect(() => {
    loadDeadlines();
  }, [loadDeadlines]);

  // NOTE: Target Closing (closing_date) is informational only — no countdown or urgency state.

  // ── Form handlers ───────────────────────────────────────────────────────────

  function openAddForm() {
    setEditingDeadline(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowForm(true);
  }

  function openEditForm(deadline: DealDeadline) {
    setEditingDeadline(deadline);
    setForm({
      title: deadline.title,
      deadline_type: deadline.deadline_type,
      due_date: deadline.due_date,
      responsible_party: deadline.responsible_party,
      client_visible: deadline.client_visible,
      notes: deadline.notes ?? '',
    });
    setFormError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingDeadline(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.due_date) {
      setFormError('Title and due date are required.');
      return;
    }
    setSaving(true);
    setFormError(null);

    if (isMockId) {
      // Optimistic mock update
      if (editingDeadline) {
        setDeadlines(prev => prev.map(d => d.id === editingDeadline.id
          ? { ...d, ...form, notes: form.notes || null, updated_at: new Date().toISOString() }
          : d
        ));
      } else {
        const newDl: DealDeadline = {
          id: `mock-dl-${Date.now()}`,
          application_id: applicationId,
          ...form,
          notes: form.notes || null,
          status: 'open',
          created_by: null,
          completed_at: null,
          completed_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setDeadlines(prev => [...prev, newDl]);
      }
      setSaving(false);
      closeForm();
      return;
    }

    try {
      const payload = {
        application_id: applicationId,
        title: form.title.trim(),
        deadline_type: form.deadline_type,
        due_date: form.due_date,
        responsible_party: form.responsible_party,
        client_visible: form.client_visible,
        notes: form.notes.trim() || null,
      };

      let res: Response;
      if (editingDeadline) {
        res = await fetch(`/api/admin/deadlines?id=${editingDeadline.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch('/api/admin/deadlines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Failed to save deadline');
      }

      await loadDeadlines();
      closeForm();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to save deadline');
    } finally {
      setSaving(false);
    }
  }

  // ── Confirm action handlers ─────────────────────────────────────────────────

  async function handleConfirmAction() {
    if (!confirmAction) return;
    setConfirming(true);

    if (isMockId) {
      const { type, deadline } = confirmAction;
      setDeadlines(prev => prev.map(d => {
        if (d.id !== deadline.id) return d;
        if (type === 'complete') return { ...d, status: 'completed', completed_at: new Date().toISOString() };
        if (type === 'cancel') return { ...d, status: 'cancelled' };
        if (type === 'reopen') return { ...d, status: 'open', completed_at: null, completed_by: null };
        return d;
      }));
      setConfirming(false);
      setConfirmAction(null);
      return;
    }

    try {
      let res = await fetch(`/api/admin/deadlines?id=${confirmAction.deadline.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: confirmAction.type }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Action failed');
      }
      await loadDeadlines();
      setConfirmAction(null);
    } catch (e: unknown) {
      // Keep modal open with error visible
      console.error(e);
    } finally {
      setConfirming(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const sorted = sortDeadlines(deadlines);

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="CalendarDaysIcon" size={16} className="text-eb-green-700" />
          <h3 className="font-display font-700 text-sm text-gray-900">Deadlines</h3>
          {deadlines.length > 0 && (
            <span className="text-[11px] font-600 text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              {deadlines.filter(d => d.status === 'open').length} open
            </span>
          )}
        </div>
        <button
          onClick={openAddForm}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all"
        >
          <Icon name="PlusIcon" size={13} />
          Add Deadline
        </button>
      </div>

      {/* ── Target Closing (informational) ────────────────────────────────── */}
      <div className="rounded-xl border p-4 bg-gray-50 border-gray-200">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-gray-200">
              <Icon name="HomeModernIcon" size={15} className="text-gray-500" />
            </div>
            <div>
              <p className="text-xs font-display font-700 text-gray-900">Target Closing</p>
              <p className="text-sm font-display font-700 mt-0.5 text-gray-700">
                {closingDate ? formatDate(closingDate) : 'Not set'}
              </p>
            </div>
          </div>
          <span className="text-[10px] font-600 text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-lg flex-shrink-0">
            Informational
          </span>
        </div>
      </div>

      {/* ── Deadline list ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <Icon name="ExclamationCircleIcon" size={14} />
          {error}
          <button onClick={loadDeadlines} className="ml-auto underline">Retry</button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Icon name="CalendarDaysIcon" size={32} className="text-gray-200 mb-3" />
          <p className="text-sm text-gray-400 font-600">No custom deadlines yet</p>
          <p className="text-xs text-gray-400 mt-1">Add deadlines to track EMD, documents, funding, and more.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((deadline) => {
            const derivedState = getDerivedState(deadline);
            const stateCfg = DERIVED_STATE_CONFIG[derivedState];
            const daysUntil = getDaysUntil(deadline.due_date);
            const isOpen = deadline.status === 'open';

            return (
              <div
                key={deadline.id}
                className={`rounded-xl border p-4 transition-all ${
                  derivedState === 'overdue'   ? 'bg-red-50 border-red-200' :
                  derivedState === 'due_today' ? 'bg-amber-50 border-amber-200' :
                  derivedState === 'completed' ? 'bg-emerald-50 border-emerald-200 opacity-80' :
                  derivedState === 'cancelled'? 'bg-gray-50 border-gray-200 opacity-60' : 'bg-white border-gray-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* State icon */}
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${stateCfg.bg} border ${stateCfg.border}`}>
                    <Icon name={stateCfg.icon as Parameters<typeof Icon>[0]['name']} size={14} className={stateCfg.color} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <p className={`text-sm font-display font-700 ${
                          derivedState === 'cancelled' ? 'text-gray-400 line-through' : 'text-gray-900'
                        }`}>
                          {deadline.title}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className="text-xs text-gray-500">{formatDate(deadline.due_date)}</span>
                          {isOpen && (
                            <span className={`text-[11px] font-600 ${stateCfg.color}`}>
                              {derivedState === 'overdue'
                                ? `${Math.abs(daysUntil)}d overdue`
                                : derivedState === 'due_today' ?'Due today'
                                : `${daysUntil}d remaining`}
                            </span>
                          )}
                          {deadline.status === 'completed' && deadline.completed_at && (
                            <span className="text-[11px] text-emerald-600 font-600">
                              Completed {formatDate(deadline.completed_at.split('T')[0])}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* State badge */}
                      <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full border flex-shrink-0 ${stateCfg.color} ${stateCfg.bg} ${stateCfg.border}`}>
                        {stateCfg.label}
                      </span>
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className={`text-[10px] font-600 px-2 py-0.5 rounded-full border ${RESPONSIBLE_PARTY_COLORS[deadline.responsible_party]}`}>
                        {RESPONSIBLE_PARTY_LABELS[deadline.responsible_party]}
                      </span>
                      <span className="text-[10px] font-600 text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                        {DEADLINE_TYPE_LABELS[deadline.deadline_type]}
                      </span>
                      {deadline.client_visible ? (
                        <span className="text-[10px] font-600 text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Icon name="EyeIcon" size={9} />
                          Visible to Client
                        </span>
                      ) : (
                        <span className="text-[10px] font-600 text-gray-400 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Icon name="EyeSlashIcon" size={9} />
                          Internal
                        </span>
                      )}
                    </div>

                    {/* Internal notes */}
                    {deadline.notes && (
                      <div className="mt-2 flex items-start gap-1.5">
                        <Icon name="LockClosedIcon" size={10} className="text-gray-300 mt-0.5 flex-shrink-0" />
                        <p className="text-[11px] text-gray-400 italic leading-relaxed">{deadline.notes}</p>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      {isOpen && (
                        <>
                          <button
                            onClick={() => openEditForm(deadline)}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-600 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all min-h-[32px]"
                          >
                            <Icon name="PencilSquareIcon" size={11} />
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirmAction({ type: 'complete', deadline })}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-600 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-all min-h-[32px]"
                          >
                            <Icon name="CheckCircleIcon" size={11} />
                            Mark Complete
                          </button>
                          <button
                            onClick={() => setConfirmAction({ type: 'cancel', deadline })}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-600 text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all min-h-[32px]"
                          >
                            <Icon name="XCircleIcon" size={11} />
                            Cancel
                          </button>
                        </>
                      )}
                      {(deadline.status === 'completed' || deadline.status === 'cancelled') && (
                        <button
                          onClick={() => setConfirmAction({ type: 'reopen', deadline })}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-600 text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-all min-h-[32px]"
                        >
                          <Icon name="ArrowPathIcon" size={11} />
                          Reopen
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Add / Edit Modal ──────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <div className="flex items-center gap-2">
                <Icon name="CalendarDaysIcon" size={16} className="text-eb-green-700" />
                <h3 className="font-display font-700 text-sm text-gray-900">
                  {editingDeadline ? 'Edit Deadline' : 'Add Deadline'}
                </h3>
              </div>
              <button
                onClick={closeForm}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-all"
              >
                <Icon name="XMarkIcon" size={16} className="text-gray-400" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4">
              {/* Title */}
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                  Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Signed PSA Due"
                  required
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 transition-all"
                />
              </div>

              {/* Type */}
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                  Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.deadline_type}
                  onChange={e => setForm(f => ({ ...f, deadline_type: e.target.value as DealDeadline['deadline_type'] }))}
                  required
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 bg-white transition-all"
                >
                  {(Object.entries(DEADLINE_TYPE_LABELS) as [DealDeadline['deadline_type'], string][]).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Due Date */}
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                  Due Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={form.due_date}
                  onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 transition-all"
                />
              </div>

              {/* Responsible Party */}
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                  Responsible Party <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2 flex-wrap">
                  {(Object.entries(RESPONSIBLE_PARTY_LABELS) as [DealDeadline['responsible_party'], string][]).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, responsible_party: val }))}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 rounded-lg border transition-all ${
                        form.responsible_party === val
                          ? RESPONSIBLE_PARTY_COLORS[val]
                          : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Visible to Client */}
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-200">
                <div>
                  <p className="text-xs font-display font-600 text-gray-700">Visible to Client</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">Show this deadline to the borrower</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, client_visible: !f.client_visible }))}
                  className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
                    form.client_visible ? 'bg-eb-green-900' : 'bg-gray-300'
                  }`}
                >
                  <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    form.client_visible ? 'translate-x-5' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              {/* Internal Notes */}
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1">
                  Internal Notes
                  <span className="ml-1.5 text-[10px] font-600 text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                    EarnestBridge internal only
                  </span>
                </label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional internal context about this deadline…"
                  rows={3}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 resize-none transition-all"
                />
                <p className="text-[10px] text-gray-400 mt-1">Not visible to borrowers.</p>
              </div>

              {formError && (
                <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                  <Icon name="ExclamationCircleIcon" size={13} />
                  {formError}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
                >
                  {saving ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="CheckIcon" size={13} />}
                  {saving ? 'Saving…' : editingDeadline ? 'Save Changes' : 'Add Deadline'}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2.5 text-xs font-600 text-gray-500 hover:text-gray-700 transition-all"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Confirm Action Modal ──────────────────────────────────────────── */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="p-5">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                confirmAction.type === 'complete' ? 'bg-emerald-100' :
                confirmAction.type === 'cancel'? 'bg-gray-100' : 'bg-blue-100'
              }`}>
                <Icon
                  name={
                    confirmAction.type === 'complete' ? 'CheckCircleIcon' :
                    confirmAction.type === 'cancel'? 'XCircleIcon' : 'ArrowPathIcon'
                  }
                  size={22}
                  className={
                    confirmAction.type === 'complete' ? 'text-emerald-600' :
                    confirmAction.type === 'cancel'? 'text-gray-500' : 'text-blue-600'
                  }
                />
              </div>
              <h3 className="font-display font-700 text-sm text-gray-900 mb-1">
                {confirmAction.type === 'complete' ? 'Mark as Complete?' :
                 confirmAction.type === 'cancel'? 'Cancel Deadline?' : 'Reopen Deadline?'}
              </h3>
              <p className="text-xs text-gray-500 leading-relaxed">
                {confirmAction.type === 'complete'
                  ? `Mark "${confirmAction.deadline.title}" as completed. This records the completion timestamp.`
                  : confirmAction.type === 'cancel'
                  ? `Cancel "${confirmAction.deadline.title}". The deadline will be preserved for history.`
                  : `Reopen "${confirmAction.deadline.title}" and set status back to open.`}
              </p>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button
                onClick={handleConfirmAction}
                disabled={confirming}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-display font-700 rounded-xl transition-all disabled:opacity-50 ${
                  confirmAction.type === 'complete' ? 'bg-emerald-600 text-white hover:bg-emerald-700' :
                  confirmAction.type === 'cancel'? 'bg-gray-700 text-white hover:bg-gray-800' : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {confirming ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : null}
                {confirming ? 'Processing…' :
                 confirmAction.type === 'complete' ? 'Mark Complete' :
                 confirmAction.type === 'cancel'? 'Cancel Deadline' : 'Reopen'}
              </button>
              <button
                onClick={() => setConfirmAction(null)}
                disabled={confirming}
                className="px-4 py-2.5 text-xs font-600 text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 transition-all"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DealDeadlinesSection;
