import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Public routes that never require authentication
const PUBLIC_PATHS = [
  '/login',
  '/sign-up-login',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  '/auth',
];

// Routes that require admin role
const ADMIN_PREFIX = '/admin';

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow Next.js internals, static files, and public assets
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/assets') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Allow public pages without any auth check
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Build a Supabase SSR client that can read the session from cookies
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — this also validates the JWT
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Rule 1: Unauthenticated → /login ──────────────────────────────────────
  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    // Preserve the intended destination so we can redirect after login
    loginUrl.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Rule 2: Non-admin on /admin/* → /dashboard-home ──────────────────────
  if (pathname.startsWith(ADMIN_PREFIX)) {
    const isAdmin = user.app_metadata?.role === 'admin';

    if (!isAdmin) {
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = '/dashboard-home';
      dashboardUrl.search = '';
      return NextResponse.redirect(dashboardUrl);
    }
  }

  return response;
}

export const config = {
  // Run on every route except Next.js internals and static files
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|assets|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|eot)).*)',
  ],
};
