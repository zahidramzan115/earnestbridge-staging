'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';

interface DealCrmContactsSectionProps {
  dealId: string;
  isMockId?: boolean;
  onUpdated?: () => void;
}

interface LinkedContact {
  contact_id: string;
  role: string;
  crm_contacts: {
    id: string;
    first_name: string;
    last_name: string;
    primary_email: string;
    portal_link_status: string;
  } | null;
}

interface SearchContact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  portal_link_status: string;
  crm_companies?: { id: string; company_name: string } | null;
}

function portalBadge(status: string) {
  if (status === 'approved') {
    return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-emerald-100 text-emerald-700">Portal Active</span>;
  }
  if (status === 'pending') {
    return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-amber-100 text-amber-700">Portal Pending</span>;
  }
  return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-gray-100 text-gray-500">No Portal</span>;
}

export default function DealCrmContactsSection({ dealId, isMockId = false, onUpdated }: DealCrmContactsSectionProps) {
  const supabase = useMemo(() => createClient(), []);
  const [linked, setLinked] = useState<LinkedContact[]>([]);
  const [loadingLinked, setLoadingLinked] = useState(true);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchContact[]>([]);
  const [associating, setAssociating] = useState(false);
  const [error, setError] = useState('');

  const loadLinked = useCallback(async () => {
    if (isMockId) {
      setLinked([]);
      setLoadingLinked(false);
      return;
    }
    setLoadingLinked(true);
    const { data } = await supabase
      .from('crm_deal_contacts')
      .select('contact_id, role, crm_contacts(id, first_name, last_name, primary_email, portal_link_status)')
      .eq('deal_id', dealId);
    setLinked(((data as unknown) as LinkedContact[]) || []);
    setLoadingLinked(false);
  }, [dealId, isMockId, supabase]);

  useEffect(() => {
    loadLinked();
  }, [loadLinked]);

  const searchContacts = async (q: string) => {
    setSearch(q);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const { data } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, portal_link_status, crm_companies(id, company_name)')
      .eq('is_merged', false)
      .is('purged_at', null)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
      .limit(8);
    setResults(((data as unknown) as SearchContact[]) || []);
  };

  const associate = async (contactId: string, role: 'primary' | 'additional') => {
    setAssociating(true);
    setError('');
    try {
      const res = await fetch(`/api/crm/deals/${dealId}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Failed to associate contact');
      } else {
        setSearch('');
        setResults([]);
        await loadLinked();
        onUpdated?.();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAssociating(false);
    }
  };

  const removeContact = async (contactId: string) => {
    setError('');
    try {
      const res = await fetch(`/api/crm/deals/${dealId}/contacts?contact_id=${contactId}`, { method: 'DELETE' });
      if (res.ok) {
        await loadLinked();
        onUpdated?.();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || 'Failed to remove contact');
      }
    } catch {
      setError('Network error. Please try again.');
    }
  };

  const primary = linked.filter(l => l.role === 'primary');
  const additional = linked.filter(l => l.role !== 'primary');

  const renderRow = (dc: LinkedContact) => (
    <div key={dc.contact_id} className="flex items-center gap-2 p-2 bg-white rounded-lg border border-gray-200">
      <Link href={`/admin/crm/contacts/${dc.contact_id}`} className="flex-1 min-w-0">
        <p className="text-xs font-600 text-gray-800 hover:text-eb-green-700">
          {dc.crm_contacts?.first_name} {dc.crm_contacts?.last_name}
        </p>
        <p className="text-[10px] text-gray-400 truncate">{dc.crm_contacts?.primary_email}</p>
      </Link>
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-700 ${dc.role === 'primary' ? 'bg-eb-green-100 text-eb-green-700' : 'bg-gray-100 text-gray-500'}`}>
        {dc.role === 'primary' ? 'Primary' : 'Additional'}
      </span>
      {portalBadge(dc.crm_contacts?.portal_link_status || 'none')}
      <button
        onClick={() => removeContact(dc.contact_id)}
        className="p-1 rounded hover:bg-red-50 transition-colors"
        title="Remove from this Deal"
      >
        <Icon name="XMarkIcon" size={12} className="text-gray-400 hover:text-red-500" />
      </button>
    </div>
  );

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon name="UserPlusIcon" size={15} className="text-eb-green-700" />
        <h3 className="font-display font-700 text-sm text-gray-900">CRM Contacts</h3>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-2">Primary Contact</p>
          {loadingLinked ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : primary.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No Primary Contact</p>
          ) : (
            <div className="space-y-1.5">{primary.map(renderRow)}</div>
          )}
        </div>

        <div>
          <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-2">Additional Contacts</p>
          {loadingLinked ? null : additional.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No additional contacts</p>
          ) : (
            <div className="space-y-1.5">{additional.map(renderRow)}</div>
          )}
        </div>

        <div>
          <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-2">Associate CRM Contact</p>
          <div className="relative">
            <Icon name="MagnifyingGlassIcon" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name or email…"
              value={search}
              onChange={e => searchContacts(e.target.value)}
              disabled={isMockId}
              className="w-full pl-8 pr-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white"
            />
          </div>
          {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
          {results.length > 0 && (
            <div className="mt-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
              {results.map(c => {
                const alreadyLinked = linked.some(dc => dc.contact_id === c.id);
                return (
                  <div key={c.id} className="flex items-center gap-2 px-3 py-2 border-b border-gray-50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-600 text-gray-800">{c.first_name} {c.last_name}</p>
                      <p className="text-[10px] text-gray-400">{c.primary_email}</p>
                      {c.crm_companies?.company_name && (
                        <p className="text-[10px] text-gray-400">{c.crm_companies.company_name}</p>
                      )}
                    </div>
                    {alreadyLinked ? (
                      <span className="text-[10px] text-gray-400">Already linked</span>
                    ) : (
                      <div className="flex gap-1">
                        <button
                          onClick={() => associate(c.id, 'primary')}
                          disabled={associating}
                          className="px-2 py-1 text-[10px] font-600 bg-eb-green-700 text-white rounded hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
                        >
                          Primary
                        </button>
                        <button
                          onClick={() => associate(c.id, 'additional')}
                          disabled={associating}
                          className="px-2 py-1 text-[10px] font-600 border border-gray-200 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-40 transition-colors"
                        >
                          Additional
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
