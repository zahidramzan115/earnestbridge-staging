'use client';
import React, { useState } from 'react';
import Icon from '@/components/ui/AppIcon';

interface Topic {
  question: string;
  answer: string;
}

interface Section {
  id: string;
  title: string;
  icon: string;
  topics: Topic[];
}

const HELP_SECTIONS: Section[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: 'RocketLaunchIcon',
    topics: [
      {
        question: 'What is EarnestBridge?',
        answer:
          'EarnestBridge provides short-term Earnest Money Deposit (EMD) financing for real estate investors. We fund the deposit required to secure a property under contract while you arrange your permanent financing or close the deal.',
      },
      {
        question: 'Who is eligible to apply?',
        answer:
          'We work with real estate investors, wholesalers, and buyers who need short-term EMD financing. You must have a signed Purchase and Sale Agreement (PSA) and a clear exit strategy (resale, refinance, or cash close).',
      },
      {
        question: 'How do I submit a new deal?',
        answer:
          'Click "New Deal" in the left sidebar to open the application form. Complete all five steps — contact info, deposit details, PSA upload, transaction details, and identity verification — then submit. You will receive a confirmation email once submitted.',
      },
      {
        question: 'What documents do I need to apply?',
        answer:
          'You will need a signed Purchase and Sale Agreement (PSA), a government-issued photo ID, and any supporting documents that demonstrate your exit strategy. Additional documents may be requested during the review process.',
      },
    ],
  },
  {
    id: 'deal-status',
    title: 'Deal Status & Review',
    icon: 'ClipboardDocumentCheckIcon',
    topics: [
      {
        question: 'What do the different deal statuses mean?',
        answer:
          'Application — your deal has been submitted and is queued for review. Under Review — our team is actively evaluating your deal. Approved — your deal has been approved and is ready to move forward. In Progress — active deal; PSA review, LLC formation, and document exchanges are underway. Funded — your EMD has been wired to escrow. Closed — the deal is complete. Rejected — the deal was not approved at this time.',
      },
      {
        question: 'How long does the review process take?',
        answer:
          'Most deals are reviewed within 1–2 business days of submission. Complex transactions or incomplete documentation may take longer. You will receive email notifications at each status change.',
      },
      {
        question: 'What are Funding Conditions?',
        answer:
          'Funding Conditions are specific items our team requires before releasing funds — such as a fully executed PSA, W-9, MOU, Option Agreement, and LLC formation. All conditions must be satisfied before funding.',
      },
      {
        question: 'Can I edit my application after submitting?',
        answer:
          'Once submitted, applications cannot be edited directly. If you need to update information or upload a revised document, please email us at admin@earnestbridge.com with your deal reference number.',
      },
    ],
  },
  {
    id: 'documents',
    title: 'Documents & Uploads',
    icon: 'FolderOpenIcon',
    topics: [
      {
        question: 'How do I upload documents for my deal?',
        answer:
          'Navigate to your deal via "Deals" in the sidebar, then open the deal and go to the Documents section. You can drag and drop files or click to browse. Supported formats: PDF, JPG, PNG, DOCX (max 20 MB per file).',
      },
      {
        question: 'Why did admin send me a document?',
        answer:
          'Our team may send you revised agreements, funding instructions, or feedback documents through the platform. You will receive an email notification when a new document is available. Check the Documents section of your deal to view and download it.',
      },
      {
        question: 'A document was flagged — what do I do?',
        answer:
          'If a document is flagged, it means our team identified an issue (e.g., missing signature, incorrect version). Review the feedback note attached to the flagged document, then upload a corrected version in the same deal.',
      },
      {
        question: 'Where can I find compliance documents?',
        answer:
          'Platform-wide compliance documents (loan agreements, disclosures, terms) are available under "Documents" → "Compliance Documents" in the sidebar.',
      },
    ],
  },
  {
    id: 'deadlines',
    title: 'Deadlines & Timelines',
    icon: 'CalendarDaysIcon',
    topics: [
      {
        question: 'How do I track my deal deadlines?',
        answer:
          'The "Deadlines" page in the sidebar shows all upcoming key dates across your active deals — including PSA expiration, inspection periods, and funding deadlines. You will also receive email reminders as deadlines approach.',
      },
      {
        question: 'What happens if I miss a deadline?',
        answer:
          'Missing a deadline can jeopardize your deal and the EMD. Contact us immediately at admin@earnestbridge.com if you anticipate a deadline issue — we may be able to assist with an extension depending on the circumstances.',
      },
      {
        question: 'Can I request a deadline extension?',
        answer:
          'Extensions are evaluated on a case-by-case basis. Email admin@earnestbridge.com with your deal reference number, the specific deadline, and the reason for the extension request as early as possible.',
      },
    ],
  },
  {
    id: 'account',
    title: 'Account & Security',
    icon: 'UserCircleIcon',
    topics: [
      {
        question: 'How do I update my profile information?',
        answer:
          'Go to "Account Settings" in the sidebar to update your name, email, and password. Changes to your email address will require re-verification.',
      },
      {
        question: 'I forgot my password — how do I reset it?',
        answer:
          'On the login page, click "Forgot password?" and enter your email address. You will receive a password reset link within a few minutes. Check your spam folder if it does not arrive.',
      },
      {
        question: 'How is my data protected?',
        answer:
          'All data is encrypted in transit and at rest. Document storage uses secure, access-controlled cloud infrastructure. Only authorized EarnestBridge staff can access your deal information.',
      },
    ],
  },
];

export default function HelpContent() {
  const [openTopics, setOpenTopics] = useState<Record<string, boolean>>({});
  const [activeSection, setActiveSection] = useState<string>('getting-started');

  const toggleTopic = (key: string) => {
    setOpenTopics((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const currentSection = HELP_SECTIONS.find((s) => s.id === activeSection) ?? HELP_SECTIONS[0];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-700 text-gray-900">Help &amp; Support</h1>
        <p className="text-sm text-gray-500 mt-1">
          Find answers to common questions about your deals, documents, and account.
        </p>
      </div>

      {/* Email support banner */}
      <div className="mb-8 flex flex-col sm:flex-row items-start sm:items-center gap-4 px-5 py-4 bg-eb-green-900 rounded-xl border border-eb-green-800">
        <div className="flex items-center gap-3 flex-1">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-eb-gold-500/20 flex-shrink-0">
            <Icon name="EnvelopeIcon" size={18} className="text-eb-gold-400" />
          </div>
          <div>
            <p className="font-display font-700 text-white text-sm">Need direct assistance?</p>
            <p className="text-xs mt-0.5 text-eb-green-300">
              Our team responds to all inquiries within 1 business day.
            </p>
          </div>
        </div>
        <a
          href="mailto:admin@earnestbridge.com"
          className="flex-shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-lg font-700 text-sm bg-eb-gold-500 hover:bg-eb-gold-400 text-gray-900 transition-all duration-150 active:scale-95"
        >
          <Icon name="EnvelopeIcon" size={15} />
          admin@earnestbridge.com
        </a>
      </div>

      {/* Two-column layout: nav + content */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Section nav */}
        <aside className="lg:w-56 flex-shrink-0">
          <nav className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <p className="px-4 pt-4 pb-2 text-[10px] font-600 uppercase tracking-widest text-gray-400 font-display">
              Topics
            </p>
            <ul className="pb-2">
              {HELP_SECTIONS.map((section) => (
                <li key={section.id}>
                  <button
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-all duration-150 text-left
                      ${activeSection === section.id
                        ? 'bg-eb-green-50 text-eb-green-900 border-r-2 border-eb-green-700' :'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                  >
                    <Icon
                      name={section.icon as Parameters<typeof Icon>[0]['name']}
                      size={16}
                      className={activeSection === section.id ? 'text-eb-green-700' : 'text-gray-400'}
                    />
                    <span className="truncate">{section.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Quick resources */}
          <div className="mt-4 bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-[10px] font-600 uppercase tracking-widest text-gray-400 font-display mb-3">
              Quick Links
            </p>
            <ul className="space-y-2">
              {[
                { label: 'Submit a New Deal', href: '/apply', icon: 'PlusCircleIcon' },
                { label: 'View My Deals', href: '/deals', icon: 'BriefcaseIcon' },
                { label: 'My Documents', href: '/documents', icon: 'FolderOpenIcon' },
                { label: 'Upcoming Deadlines', href: '/deadlines', icon: 'CalendarDaysIcon' },
                { label: 'Account Settings', href: '/profile-account-settings', icon: 'UserCircleIcon' },
              ].map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="flex items-center gap-2 text-sm text-gray-600 hover:text-eb-green-800 transition-colors"
                  >
                    <Icon
                      name={link.icon as Parameters<typeof Icon>[0]['name']}
                      size={14}
                      className="text-gray-400 flex-shrink-0"
                    />
                    <span>{link.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* FAQ accordion */}
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Section header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-eb-green-50">
                <Icon
                  name={currentSection.icon as Parameters<typeof Icon>[0]['name']}
                  size={16}
                  className="text-eb-green-700"
                />
              </div>
              <h2 className="font-display font-700 text-gray-900 text-base">{currentSection.title}</h2>
              <span className="ml-auto text-xs text-gray-400">{currentSection.topics.length} topics</span>
            </div>

            {/* Topics */}
            <ul className="divide-y divide-gray-100">
              {currentSection.topics.map((topic, idx) => {
                const key = `${currentSection.id}-${idx}`;
                const isOpen = !!openTopics[key];
                return (
                  <li key={key}>
                    <button
                      onClick={() => toggleTopic(key)}
                      className="w-full flex items-start gap-4 px-6 py-4 text-left hover:bg-gray-50 transition-colors group"
                    >
                      <span
                        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center transition-colors
                          ${isOpen ? 'bg-eb-green-700 text-white' : 'bg-gray-100 text-gray-400 group-hover:bg-eb-green-50 group-hover:text-eb-green-700'}`}
                      >
                        <Icon name={isOpen ? 'MinusIcon' : 'PlusIcon'} size={10} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-600 leading-snug ${isOpen ? 'text-eb-green-900' : 'text-gray-800'}`}>
                          {topic.question}
                        </p>
                        {isOpen && (
                          <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                            {topic.answer}
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Still need help */}
          <div className="mt-4 flex items-center gap-4 px-5 py-4 bg-gray-50 rounded-xl border border-gray-200">
            <Icon name="ChatBubbleLeftEllipsisIcon" size={20} className="text-gray-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-600 text-gray-700">Still have questions?</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Email us at{' '}
                <a
                  href="mailto:admin@earnestbridge.com"
                  className="text-eb-green-700 hover:underline font-600"
                >
                  admin@earnestbridge.com
                </a>{' '}
                and we will get back to you within 1 business day.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
