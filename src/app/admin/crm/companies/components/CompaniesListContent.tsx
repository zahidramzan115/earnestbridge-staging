'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';

import { useRouter } from 'next/navigation';

interface Company {
  id: string;
  company_name: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  company_type: string | null;
  assigned_owner: string;
  created_at: string;
  crm_contacts?: { count: number }[];
}

const OWNERS = ['Dan', 'Tucker', 'Eric', 'Unassigned'];

export default function CompaniesListContent() {
  const supabase = createClient();
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({ company_name: '', website: '', phone: '', city: '', state: '', company_type: '', assigned_owner: 'Unassigned' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('crm_companies')
      .select('*, crm_contacts(count)', { count: 'exact' })
      .order('company_name', { ascending: true })
      .limit(100);

    if (search) query = query.ilike('company_name', `%${search}%`);

    const { data, count } = await query;
    setCompanies((data as Company[]) || []);
    setTotal(count || 0);
    setLoading(false);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newForm.company_name.trim()) return;
    setSaving(true);
    const { data } = await supabase.from('crm_companies').insert(newForm).select('id').single();
    setSaving(false);
    setShowNewForm(false);
    setNewForm({ company_name: '', website: '', phone: '', city: '', state: '', company_type: '', assigned_owner: 'Unassigned' });
    if (data) router.push(`/admin/crm/companies/${data.id}`);
    else load();
  };

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-700 text-gray-900 font-display tracking-tight">Companies</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} company records</p>
        </div>
        <button
          onClick={() => setShowNewForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors"
        >
          <Icon name="PlusIcon" size={16} />
          New Company
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search companies…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500"
        />
      </div>

      {/* New Company Form */}
      {showNewForm && (
        <form onSubmit={handleCreate} className="bg-white rounded-xl border border-eb-green-200 p-5 space-y-4">
          <h3 className="text-sm font-700 text-gray-800">New Company</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-600 text-gray-500 mb-1">Company Name <span className="text-red-500">*</span></label>
              <input required type="text" value={newForm.company_name} onChange={(e) => setNewForm((f) => ({ ...f, company_name: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-500 mb-1">Website</label>
              <input type="text" value={newForm.website} onChange={(e) => setNewForm((f) => ({ ...f, website: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-500 mb-1">Phone</label>
              <input type="tel" value={newForm.phone} onChange={(e) => setNewForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-500 mb-1">City</label>
              <input type="text" value={newForm.city} onChange={(e) => setNewForm((f) => ({ ...f, city: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-500 mb-1">State</label>
              <input type="text" value={newForm.state} onChange={(e) => setNewForm((f) => ({ ...f, state: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-500 mb-1">Owner</label>
              <select value={newForm.assigned_owner} onChange={(e) => setNewForm((f) => ({ ...f, assigned_owner: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
                {OWNERS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={saving}
              className="px-5 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
              {saving ? 'Creating…' : 'Create Company'}
            </button>
            <button type="button" onClick={() => setShowNewForm(false)}
              className="px-5 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-6 h-6 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : companies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <Icon name="BuildingOfficeIcon" size={32} className="text-gray-300" />
            <p className="text-sm text-gray-400">No companies yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden md:table-cell">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden lg:table-cell">Phone</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Contacts</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden md:table-cell">Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {companies.map((c) => {
                  const contactCount = (c.crm_contacts as any)?.[0]?.count || 0;
                  return (
                    <tr key={c.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => router.push(`/admin/crm/companies/${c.id}`)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                            <Icon name="BuildingOfficeIcon" size={14} className="text-gray-500" />
                          </div>
                          <div>
                            <p className="font-600 text-gray-900">{c.company_name}</p>
                            {c.website && <p className="text-xs text-gray-400">{c.website}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-gray-500">
                          {[c.city, c.state].filter(Boolean).join(', ') || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-sm text-gray-500">{c.phone || '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm font-600 ${contactCount > 0 ? 'text-eb-green-700' : 'text-gray-400'}`}>
                          {contactCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-gray-600">{c.assigned_owner}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
