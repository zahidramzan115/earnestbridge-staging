import type { Metadata } from 'next';
import PaymentContent from './components/PaymentContent';

export const metadata: Metadata = {
  title: 'Pay an Invoice — EarnestBridge',
  description: 'Securely pay your EarnestBridge invoice by credit card.',
  robots: { index: false, follow: false },
};

export default function PaymentPage() {
  return <PaymentContent />;
}
