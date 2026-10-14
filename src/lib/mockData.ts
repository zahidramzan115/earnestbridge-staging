export type ApplicationStatus =
'application' | 'under_review' | 'approved' | 'in_progress' | 'funded' | 'closed' | 'rejected';

export type DocumentStatus = 'pending' | 'uploaded' | 'approved' | 'rejected';

export interface EMDApplication {
  id: string;
  dealName: string;
  propertyAddress: string;
  propertyType: 'Multifamily' | 'Office' | 'Retail' | 'Industrial' | 'Mixed-Use' | 'Hotel';
  emdAmount: number;
  purchasePrice: number;
  ltv: number;
  status: ApplicationStatus;
  submittedDate: string;
  closingDate: string;
  actionItemsCount: number;
  daysToFunding?: number;
  fundedDate?: string;
  lender?: string;
  milestoneStep: number; // 0-6
}

export interface ActionItem {
  id: string;
  applicationId: string;
  dealName: string;
  type: 'document' | 'signature' | 'information' | 'payment';
  description: string;
  dueDate: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ActivityEvent {
  id: string;
  applicationId: string;
  dealName: string;
  event: string;
  detail: string;
  timestamp: string;
  actor: string;
}

export interface Document {
  id: string;
  applicationId: string;
  name: string;
  category: string;
  status: DocumentStatus;
  uploadedDate?: string;
  notes?: string;
  required: boolean;
  fileUrl?: string;
  thumbnailUrl?: string;
  fileType?: 'image' | 'pdf' | 'other';
}

export const MOCK_APPLICATIONS: EMDApplication[] = [
{
  id: 'app-001',
  dealName: 'Westlake Commons Acquisition',
  propertyAddress: '4821 Westlake Blvd, Austin, TX 78746',
  propertyType: 'Multifamily',
  emdAmount: 250000,
  purchasePrice: 8500000,
  ltv: 2.94,
  status: 'funded',
  submittedDate: '2026-03-15',
  closingDate: '2026-04-22',
  actionItemsCount: 0,
  daysToFunding: 14,
  fundedDate: '2026-03-29',
  lender: 'Arbor Realty Trust',
  milestoneStep: 5
},
{
  id: 'app-002',
  dealName: 'Harbor Point Industrial Park',
  propertyAddress: '1102 Commerce Dr, Houston, TX 77032',
  propertyType: 'Industrial',
  emdAmount: 500000,
  purchasePrice: 18200000,
  ltv: 2.75,
  status: 'approved',
  submittedDate: '2026-03-28',
  closingDate: '2026-04-30',
  actionItemsCount: 2,
  lender: 'Mesa West Capital',
  milestoneStep: 4
},
{
  id: 'app-003',
  dealName: 'Midtown Lofts Portfolio',
  propertyAddress: '308 W 5th St, Charlotte, NC 28202',
  propertyType: 'Multifamily',
  emdAmount: 175000,
  purchasePrice: 5750000,
  ltv: 3.04,
  status: 'under_review',
  submittedDate: '2026-04-02',
  closingDate: '2026-05-15',
  actionItemsCount: 3,
  milestoneStep: 2
},
{
  id: 'app-004',
  dealName: 'Riverside Retail Center',
  propertyAddress: '9900 Riverside Pkwy, Atlanta, GA 30339',
  propertyType: 'Retail',
  emdAmount: 320000,
  purchasePrice: 11400000,
  ltv: 2.81,
  status: 'approved',
  submittedDate: '2026-03-20',
  closingDate: '2026-04-18',
  actionItemsCount: 1,
  lender: 'Ready Capital',
  milestoneStep: 3
},
{
  id: 'app-005',
  dealName: 'Summit Office Plaza',
  propertyAddress: '2400 Summit Ave, Denver, CO 80203',
  propertyType: 'Office',
  emdAmount: 400000,
  purchasePrice: 14600000,
  ltv: 2.74,
  status: 'application',
  submittedDate: '2026-04-07',
  closingDate: '2026-05-28',
  actionItemsCount: 0,
  milestoneStep: 1
},
{
  id: 'app-006',
  dealName: 'Northgate Mixed-Use',
  propertyAddress: '5501 N Lamar Blvd, Austin, TX 78751',
  propertyType: 'Mixed-Use',
  emdAmount: 280000,
  purchasePrice: 9800000,
  ltv: 2.86,
  status: 'closed',
  submittedDate: '2026-02-10',
  closingDate: '2026-03-28',
  actionItemsCount: 0,
  daysToFunding: 11,
  fundedDate: '2026-02-21',
  lender: 'Ladder Capital',
  milestoneStep: 6
},
{
  id: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  propertyAddress: '720 Lake Shore Dr, Chicago, IL 60611',
  propertyType: 'Hotel',
  emdAmount: 750000,
  purchasePrice: 28500000,
  ltv: 2.63,
  status: 'under_review',
  submittedDate: '2026-04-05',
  closingDate: '2026-05-20',
  actionItemsCount: 4,
  milestoneStep: 2
},
{
  id: 'app-008',
  dealName: 'Parkview Apartments',
  propertyAddress: '3311 Parkview Dr, Phoenix, AZ 85016',
  propertyType: 'Multifamily',
  emdAmount: 195000,
  purchasePrice: 7200000,
  ltv: 2.71,
  status: 'application',
  submittedDate: '2026-04-09',
  closingDate: '2026-06-01',
  actionItemsCount: 5,
  milestoneStep: 0
}];


export const MOCK_ACTION_ITEMS: ActionItem[] = [
{
  id: 'action-001',
  applicationId: 'app-002',
  dealName: 'Harbor Point Industrial Park',
  type: 'document',
  description: 'Upload signed Purchase & Sale Agreement (PSA)',
  dueDate: '2026-04-14',
  priority: 'high'
},
{
  id: 'action-002',
  applicationId: 'app-002',
  dealName: 'Harbor Point Industrial Park',
  type: 'signature',
  description: 'Execute EarnestBridge Loan Agreement',
  dueDate: '2026-04-16',
  priority: 'high'
},
{
  id: 'action-003',
  applicationId: 'app-003',
  dealName: 'Midtown Lofts Portfolio',
  type: 'document',
  description: 'Provide Phase I Environmental Report',
  dueDate: '2026-04-18',
  priority: 'medium'
},
{
  id: 'action-004',
  applicationId: 'app-003',
  dealName: 'Midtown Lofts Portfolio',
  type: 'information',
  description: 'Confirm entity structure and ownership percentage',
  dueDate: '2026-04-19',
  priority: 'medium'
},
{
  id: 'action-005',
  applicationId: 'app-003',
  dealName: 'Midtown Lofts Portfolio',
  type: 'document',
  description: 'Upload trailing 12-month rent roll',
  dueDate: '2026-04-20',
  priority: 'low'
},
{
  id: 'action-006',
  applicationId: 'app-004',
  dealName: 'Riverside Retail Center',
  type: 'signature',
  description: 'Sign commitment letter for conditional approval',
  dueDate: '2026-04-13',
  priority: 'high'
},
{
  id: 'action-007',
  applicationId: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  type: 'document',
  description: 'Upload STR/hotel operating statements (3 years)',
  dueDate: '2026-04-17',
  priority: 'high'
},
{
  id: 'action-008',
  applicationId: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  type: 'document',
  description: 'Provide franchise agreement or brand affiliation docs',
  dueDate: '2026-04-18',
  priority: 'medium'
},
{
  id: 'action-009',
  applicationId: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  type: 'information',
  description: 'Clarify management company and fee structure',
  dueDate: '2026-04-20',
  priority: 'medium'
},
{
  id: 'action-010',
  applicationId: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  type: 'payment',
  description: 'Remit $2,500 appraisal deposit',
  dueDate: '2026-04-15',
  priority: 'high'
},
{
  id: 'action-011',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  type: 'document',
  description: 'Upload personal financial statement',
  dueDate: '2026-04-22',
  priority: 'medium'
},
{
  id: 'action-012',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  type: 'document',
  description: 'Provide 2023 & 2024 federal tax returns',
  dueDate: '2026-04-22',
  priority: 'medium'
},
{
  id: 'action-013',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  type: 'document',
  description: 'Upload entity formation documents (Articles of Organization)',
  dueDate: '2026-04-23',
  priority: 'low'
},
{
  id: 'action-014',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  type: 'information',
  description: 'Confirm target closing date with title company',
  dueDate: '2026-04-25',
  priority: 'low'
},
{
  id: 'action-015',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  type: 'document',
  description: 'Upload executed Letter of Intent (LOI)',
  dueDate: '2026-04-21',
  priority: 'high'
}];


export const MOCK_ACTIVITY: ActivityEvent[] = [
{
  id: 'evt-001',
  applicationId: 'app-002',
  dealName: 'Harbor Point Industrial Park',
  event: 'Application Approved',
  detail: 'Your application has been approved. Loan agreement sent for signature.',
  timestamp: '2026-04-10T14:32:00Z',
  actor: 'EarnestBridge Underwriting'
},
{
  id: 'evt-002',
  applicationId: 'app-004',
  dealName: 'Riverside Retail Center',
  event: 'Conditional Approval Issued',
  detail: 'Conditionally approved pending signed commitment letter.',
  timestamp: '2026-04-09T11:15:00Z',
  actor: 'EarnestBridge Credit Team'
},
{
  id: 'evt-003',
  applicationId: 'app-007',
  dealName: 'Lakewood Hotel Portfolio',
  event: 'Documents Requested',
  detail: 'Underwriter requested hotel operating statements and franchise docs.',
  timestamp: '2026-04-08T16:45:00Z',
  actor: 'EarnestBridge Underwriting'
},
{
  id: 'evt-004',
  applicationId: 'app-003',
  dealName: 'Midtown Lofts Portfolio',
  event: 'Review In Progress',
  detail: 'Application entered underwriting queue. Initial review underway.',
  timestamp: '2026-04-07T09:00:00Z',
  actor: 'EarnestBridge Underwriting'
},
{
  id: 'evt-005',
  applicationId: 'app-005',
  dealName: 'Summit Office Plaza',
  event: 'Application Submitted',
  detail: 'Application received and assigned reference #EB-2026-0112.',
  timestamp: '2026-04-07T08:22:00Z',
  actor: 'System'
},
{
  id: 'evt-006',
  applicationId: 'app-001',
  dealName: 'Westlake Commons Acquisition',
  event: 'EMD Funded',
  detail: '$250,000 wired to escrow at Republic Title of Texas.',
  timestamp: '2026-03-29T13:00:00Z',
  actor: 'EarnestBridge Funding'
},
{
  id: 'evt-007',
  applicationId: 'app-006',
  dealName: 'Northgate Mixed-Use',
  event: 'Deal Closed',
  detail: 'Transaction closed successfully. EMD returned per agreement.',
  timestamp: '2026-03-28T15:30:00Z',
  actor: 'System'
},
{
  id: 'evt-008',
  applicationId: 'app-008',
  dealName: 'Parkview Apartments',
  event: 'Draft Application Created',
  detail: 'Application draft created. Complete all required fields to submit.',
  timestamp: '2026-04-09T10:05:00Z',
  actor: 'You'
}];


export const MOCK_DOCUMENTS: Document[] = [
{
  id: 'doc-001',
  applicationId: 'app-002',
  name: 'Purchase & Sale Agreement (PSA)',
  category: 'Transaction',
  status: 'uploaded',
  uploadedDate: '2026-04-06',
  required: true,
  fileType: 'pdf',
  fileUrl: 'https://www.w3.org/WAI/WCAG21/Techniques/pdf/sample.pdf',
  thumbnailUrl: "https://img.rocket.new/generatedImages/rocket_gen_img_111167a66-1768060707977.png"
},
{ id: 'doc-002', applicationId: 'app-002', name: 'EarnestBridge Loan Agreement', category: 'Loan', status: 'pending', required: true },
{ id: 'doc-003', applicationId: 'app-002', name: 'Entity Formation Documents', category: 'Entity', status: 'approved', uploadedDate: '2026-04-01', required: true },
{ id: 'doc-004', applicationId: 'app-002', name: 'Personal Financial Statement', category: 'Financial', status: 'approved', uploadedDate: '2026-04-01', required: true },
{ id: 'doc-005', applicationId: 'app-002', name: '2023–2024 Federal Tax Returns', category: 'Financial', status: 'approved', uploadedDate: '2026-04-02', required: true },
{ id: 'doc-006', applicationId: 'app-002', name: 'Property Appraisal (if available)', category: 'Property', status: 'uploaded', uploadedDate: '2026-04-05', required: false },
{ id: 'doc-007', applicationId: 'app-002', name: 'Rent Roll (Trailing 12 Months)', category: 'Financial', status: 'approved', uploadedDate: '2026-04-03', required: true },
{ id: 'doc-008', applicationId: 'app-002', name: 'Phase I Environmental Report', category: 'Property', status: 'pending', required: false },
{ id: 'doc-009', applicationId: 'app-002', name: 'Certificate of Good Standing', category: 'Entity', status: 'approved', uploadedDate: '2026-04-01', required: true },
{ id: 'doc-010', applicationId: 'app-002', name: 'Proof of Funds / Bank Statement', category: 'Financial', status: 'approved', uploadedDate: '2026-04-02', required: true },
{
  id: 'doc-011',
  applicationId: 'app-002',
  name: 'Government-Issued ID',
  category: 'Identity',
  status: 'approved',
  uploadedDate: '2026-04-04',
  required: true,
  fileType: 'image',
  fileUrl: 'https://images.unsplash.com/photo-1633265486064-086b219458ec?w=800&auto=format',
  thumbnailUrl: 'https://images.unsplash.com/photo-1633265486064-086b219458ec?w=120&h=90&fit=crop&auto=format'
},
{
  id: 'doc-012',
  applicationId: 'app-002',
  name: 'Selfie / Identity Photo',
  category: 'Identity',
  status: 'approved',
  uploadedDate: '2026-04-04',
  required: true,
  fileType: 'image',
  fileUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format',
  thumbnailUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=90&fit=crop&auto=format'
}];


export const ACTIVITY_CHART_DATA = [
{ week: 'Jan W3', applications: 1, funded: 0 },
{ week: 'Jan W4', applications: 0, funded: 0 },
{ week: 'Feb W1', applications: 2, funded: 1 },
{ week: 'Feb W2', applications: 1, funded: 0 },
{ week: 'Feb W3', applications: 0, funded: 1 },
{ week: 'Feb W4', applications: 1, funded: 0 },
{ week: 'Mar W1', applications: 2, funded: 0 },
{ week: 'Mar W2', applications: 1, funded: 1 },
{ week: 'Mar W3', applications: 3, funded: 1 },
{ week: 'Mar W4', applications: 2, funded: 2 },
{ week: 'Apr W1', applications: 3, funded: 0 },
{ week: 'Apr W2', applications: 2, funded: 1 }];


export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  application: 'Application',
  under_review: 'Under Review',
  approved: 'Approved',
  in_progress: 'In Progress',
  funded: 'Funded',
  closed: 'Closed',
  rejected: 'Rejected'
};

export const STATUS_COLORS: Record<ApplicationStatus, string> = {
  application: 'bg-gray-100 text-gray-600',
  under_review: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  in_progress: 'bg-blue-50 text-blue-700',
  funded: 'bg-eb-green-100 text-eb-green-800',
  closed: 'bg-slate-100 text-slate-600',
  rejected: 'bg-red-50 text-red-600'
};

export const MILESTONE_STEPS = [
{
  phase: 'Step 1',
  label: 'Submit Application',
  short: 'Application',
  steps: [
  { id: '1.1', label: 'Submit Application', description: 'Start the partnership by completing and submitting your EarnestBridge application.' }]

},
{
  phase: 'Step 2',
  label: 'Sign NDA',
  short: 'NDA',
  steps: [
  { id: '2.1', label: 'Sign NDA', description: 'Keep your data and deals secure by signing the Non-Disclosure Agreement.' }]

},
{
  phase: 'Step 3',
  label: 'Review MOU',
  short: 'MOU',
  steps: [
  { id: '3.1', label: 'Review MOU', description: 'Review the Memorandum of Understanding to outline our program standards.' }]

},
{
  phase: 'Step 4',
  label: 'PSA Review',
  short: 'PSA Review',
  steps: [
  { id: '4.1', label: 'PSA Review', description: 'Get our "green light" before you sign with the seller. We will review your Purchase and Sale Agreement.' }]

},
{
  phase: 'Step 5',
  label: 'Invoice Approval',
  short: 'Invoice',
  steps: [
  { id: '5.1', label: 'Invoice Approval', description: 'Confirm the numbers — no surprises. Review and approve the invoice for the upfront fee.' }]

},
{
  phase: 'Step 6',
  label: 'Entity Setup',
  short: 'Entity',
  steps: [
  { id: '6.1', label: 'Entity Setup', description: 'Form your deal-specific LLC. We handle the formation once payment is verified.' }]

},
{
  phase: 'Step 7',
  label: 'Execute Option Agreement',
  short: 'Option Agreement',
  steps: [
  { id: '7.1', label: 'Execute Option Agreement', description: 'Finalize the funding terms by signing the Call Option Agreement via Adobe Sign.' }]

},
{
  phase: 'Step 8',
  label: 'Upload W-9',
  short: 'W-9',
  steps: [
  { id: '8.1', label: 'Upload W-9', description: 'Complete the compliance check by uploading your W-9 form.' }]

},
{
  phase: 'Step 9',
  label: 'EMD Funded',
  short: 'Funded',
  steps: [
  { id: '9.1', label: 'EMD Funded', description: 'Capital deployed. Your Earnest Money Deposit has been funded and the deal is active.' }]

}];