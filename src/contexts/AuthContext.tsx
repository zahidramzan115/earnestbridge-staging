
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const AuthContext = createContext<any>({});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Email/Password Sign Up
  const signUp = async (email: string, password: string, metadata = {}) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: (metadata as any)?.fullName || '',
          avatar_url: (metadata as any)?.avatarUrl || '',
          phone: (metadata as any)?.phone || '',
          company: (metadata as any)?.company || ''
        },
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || window.location.origin}/auth/callback`
      }
    });
    if (error) throw error;

    // With "Confirm email" ON, Supabase returns a user with NO session and sends
    // its own native confirmation email. That is expected, not an error.
    // No custom verification email is sent from application code.
    return data;
  };

  // Email/Password Sign In
  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) throw error;

    // Block unverified borrowers from accessing the dashboard
    // Exceptions: demo account and admin users are always allowed through
    const isDemoAccount = email === 'marcus.reid@reidcapitalgroup.com';
    const isAdminUser = data?.user?.app_metadata?.role === 'admin';

    if (!isDemoAccount && !isAdminUser && data?.user && !data.user.email_confirmed_at) {
      // Sign them back out immediately so no session is persisted
      await supabase.auth.signOut();
      throw new Error('Please verify your email address before signing in. Check your inbox for the confirmation link.');
    }

    // Best-effort safety net: ensure a verified Client has a CRM Contact.
    // Never blocks or fails sign-in. Identity comes from the server session.
    if (!isDemoAccount && !isAdminUser && data?.user?.email_confirmed_at) {
      try {
        void fetch('/api/portal/ensure-crm-contact', {
          method: 'POST',
          credentials: 'same-origin',
        }).catch(() => {});
      } catch {
        // ignore
      }
    }

    return data;
  };

  // Sign Out
  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  // Get Current User
  const getCurrentUser = async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user;
  };

  // Check if Email is Verified
  const isEmailVerified = () => {
    return !!user?.email_confirmed_at;
  };

  // Check if current user is admin
  const isAdmin = () => {
    if (!user) return false;
    return user.app_metadata?.role === 'admin';
  };

  // Check if current user is SuperAdmin
  // SuperAdmin requires BOTH role === 'admin' AND is_superadmin === true.
  // Neither condition alone is sufficient.
  // Trusts ONLY app_metadata — never user_metadata, email, or caller-supplied values.
  const isSuperAdmin = () => {
    if (!user) return false;
    return (
      user.app_metadata?.role === 'admin' &&
      user.app_metadata?.is_superadmin === true
    );
  };

  // Get User Profile from Database
  const getUserProfile = async () => {
    if (!user) return null;
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (error) throw error;
    return data;
  };

  const value = {
    user,
    session,
    loading,
    signUp,
    signIn,
    signOut,
    getCurrentUser,
    isEmailVerified,
    isAdmin,
    isSuperAdmin,
    getUserProfile
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
