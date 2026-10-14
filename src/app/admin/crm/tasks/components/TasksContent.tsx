'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: string;
  task_status: string;
  assigned_to: string;
  created_at: string;
  crm_contacts?: { id: string; first_name: string; last_name: string } | null;
  crm_companies?: { id: string; company_name: string } | null;
}

const OWNERS = ['Dan', 'Tucker', 'Eric', 'Unassigned'];
const VIEWS = [
  { key: 'upcoming',  label: 'Upcoming' },
  { key: 'due_today', label: 'Due Today' },
  { key: 'overdue',   label: 'Overdue' },
  { key: 'all',       label: 'All Open' },
  { key: 'completed', label: 'Completed' },
  { key: 'unassigned',label: 'Unassigned' },
];

const PRIORITY_COLORS: Record<string, string> = {
  High:   'bg-red-100 text-red-700',
  Normal: 'bg-amber-100 text-amber-700',
  Low:    'bg-gray-100 text-gray-500',
};

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function isOverdue(d: string | null) {
  if (!d) return false;
  return new Date(d + 'T23:59:59') < new Date();
}

export default function TasksContent() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [view, setView] = useState(searchParams.get('view') || 'upcoming');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({ title: '', description: '', due_date: '', priority: 'Normal', assigned_to: 'Unassigned' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];

    let query = supabase
      .from('crm_tasks')
      .select('*, crm_contacts(id, first_name, last_name), crm_companies(id, company_name)')
      .order('due_date', { ascending: true, nullsFirst: false });

    switch (view) {
      case 'due_today':
        query = query.eq('due_date', today).eq('task_status', 'Open');
        break;
      case 'overdue':
        query = query.lt('due_date', today).eq('task_status', 'Open');
        break;
      case 'upcoming':
        query = query.gte('due_date', today).eq('task_status', 'Open');
        break;
      case 'completed':
        query = query.eq('task_status', 'Completed').order('completed_at', { ascending: false });
        break;
      case 'unassigned':
        query = query.eq('assigned_to', 'Unassigned').eq('task_status', 'Open');
        break;
      default:
        query = query.eq('task_status', 'Open');
    }

    const { data } = await query.limit(200);
    setTasks((data as Task[]) || []);
    setLoading(false);
  }, [view]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newForm.title.trim()) return;
    setSaving(true);
    await supabase.from('crm_tasks').insert({
      title: newForm.title,
      description: newForm.description || null,
      due_date: newForm.due_date || null,
      priority: newForm.priority,
      assigned_to: newForm.assigned_to,
      task_status: 'Open',
    });
    setNewForm({ title: '', description: '', due_date: '', priority: 'Normal', assigned_to: 'Unassigned' });
    setShowNewForm(false);
    setSaving(false);
    load();
  };

  const handleComplete = async (id: string) => {
    await supabase.from('crm_tasks').update({
      task_status: 'Completed',
      completed_at: new Date().toISOString(),
    }).eq('id', id);
    load();
  };

  const currentView = VIEWS.find((v) => v.key === view);

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-700 text-gray-900 font-display tracking-tight">Tasks</h1>
          <p className="text-sm text-gray-500 mt-0.5">Follow-ups and action items</p>
        </div>
        <button
          onClick={() => setShowNewForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors"
        >
          <Icon name="PlusIcon" size={16} />
          New Task
        </button>
      </div>

      {/* View Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-600 transition-all ${
              view === v.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* New Task Form */}
      {showNewForm && (
        <form onSubmit={handleCreate} className="bg-white rounded-xl border border-eb-green-200 p-5 space-y-3">
          <h3 className="text-sm font-700 text-gray-800">New Task</h3>
          <input required type="text" placeholder="Task title…" value={newForm.title}
            onChange={(e) => setNewForm((f) => ({ ...f, title: e.target.value }))}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
          <textarea placeholder="Description (optional)…" value={newForm.description}
            onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))} rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none resize-none" />
          <div className="flex flex-wrap gap-2">
            <input type="date" value={newForm.due_date} onChange={(e) => setNewForm((f) => ({ ...f, due_date: e.target.value }))}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
            <select value={newForm.priority} onChange={(e) => setNewForm((f) => ({ ...f, priority: e.target.value }))}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
              <option>Low</option><option>Normal</option><option>High</option>
            </select>
            <select value={newForm.assigned_to} onChange={(e) => setNewForm((f) => ({ ...f, assigned_to: e.target.value }))}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
              {OWNERS.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={saving}
              className="px-5 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
              {saving ? 'Creating…' : 'Create Task'}
            </button>
            <button type="button" onClick={() => setShowNewForm(false)}
              className="px-5 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Tasks List */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <p className="text-xs font-600 text-gray-500 uppercase tracking-wider">
            {currentView?.label} — {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-6 h-6 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <Icon name="CheckCircleIcon" size={32} className="text-gray-300" />
            <p className="text-sm text-gray-400">No tasks in this view</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {tasks.map((t) => {
              const overdue = isOverdue(t.due_date) && t.task_status === 'Open';
              return (
                <div key={t.id} className={`flex items-start gap-3 px-5 py-4 ${overdue ? 'bg-red-50/50' : ''}`}>
                  <button
                    onClick={() => t.task_status === 'Open' && handleComplete(t.id)}
                    className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      t.task_status === 'Completed'
                        ? 'border-emerald-400 bg-emerald-400'
                        : overdue
                        ? 'border-red-400 hover:border-red-500' :'border-gray-300 hover:border-eb-green-500'
                    }`}
                  >
                    {t.task_status === 'Completed' && <Icon name="CheckIcon" size={10} className="text-white" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm font-600 ${t.task_status === 'Completed' ? 'line-through text-gray-400' : overdue ? 'text-red-700' : 'text-gray-800'}`}>
                        {t.title}
                      </p>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 ${PRIORITY_COLORS[t.priority] || 'bg-gray-100 text-gray-500'}`}>
                          {t.priority}
                        </span>
                      </div>
                    </div>
                    {t.description && <p className="text-xs text-gray-500 mt-0.5">{t.description}</p>}
                    <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-gray-400">
                      {t.due_date && (
                        <span className={overdue ? 'text-red-500 font-600' : ''}>
                          {overdue ? '⚠ Overdue · ' : ''}{formatDate(t.due_date)}
                        </span>
                      )}
                      <span>→ {t.assigned_to}</span>
                      {(t.crm_contacts as any) && (
                        <Link href={`/admin/crm/contacts/${(t.crm_contacts as any).id}`} className="text-eb-green-600 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {(t.crm_contacts as any).first_name} {(t.crm_contacts as any).last_name}
                        </Link>
                      )}
                      {(t.crm_companies as any) && (
                        <Link href={`/admin/crm/companies/${(t.crm_companies as any).id}`} className="text-gray-500 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {(t.crm_companies as any).company_name}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
