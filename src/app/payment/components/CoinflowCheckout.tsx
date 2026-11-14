'use client';
import React, { useState } from 'react';
import {
  ChargebackProtectionAccountType,
  CoinflowPurchase,
  Currency,
  MerchantStyle,
  type MerchantTheme,
  PaymentMethods,
} from '@coinflowlabs/react';

// Coinflow hosted card checkout (iframe). Card data goes straight to Coinflow.
// Loaded client-side only (see PaymentContent) because the SDK touches window.

export interface CoinflowSession {
  coinflow: {
    merchantId: string;
    env: 'sandbox' | 'prod';
    sessionKey: string;
    jwtToken: string;
  };
  subtotalCents: number;
  email: string;
  customerInfo: { firstName: string; lastName: string; email: string };
  webhookInfo: Record<string, string>;
  chargebackProtectionData: Array<{
    productName: string;
    productType: 'realEstate';
    quantity: number;
    listPrice: { valueInCurrency: number; currency: string };
    rawProductData: Record<string, string>;
  }>;
}

// Light theme in EarnestBridge green, matching the rest of the page.
const LIGHT_THEME: MerchantTheme = {
  background: '#ffffff',
  cardBackground: '#ffffff',
  backgroundAccent: '#f9fafb',
  backgroundAccent2: '#f3f4f6',
  textColor: '#111827',
  textColorAccent: '#6b7280',
  textColorAction: '#ffffff',
  placeholderColor: '#9ca3af',
  primary: '#1a4a35',
  ctaColor: '#1a4a35',
  style: MerchantStyle.Rounded,
};

interface Props {
  session: CoinflowSession;
  onSuccess: (paymentId: string) => void;
  onDeclined: (message: string) => void;
}

export default function CoinflowCheckout({ session, onSuccess, onDeclined }: Props) {
  const [height, setHeight] = useState(600);

  return (
    <div style={{ height }} className="w-full">
      <CoinflowPurchase
        merchantId={session.coinflow.merchantId}
        env={session.coinflow.env}
        sessionKey={session.coinflow.sessionKey}
        jwtToken={session.coinflow.jwtToken}
        subtotal={{ cents: session.subtotalCents, currency: Currency.USD }}
        email={session.email}
        customerInfo={session.customerInfo}
        webhookInfo={session.webhookInfo}
        chargebackProtectionData={session.chargebackProtectionData}
        chargebackProtectionAccountType={ChargebackProtectionAccountType.GUEST}
        allowedPaymentMethods={[PaymentMethods.card]}
        theme={LIGHT_THEME}
        loaderBackground="#ffffff"
        handleHeightChange={(h) => {
          const n = parseInt(h, 10);
          if (Number.isFinite(n) && n > 0) setHeight(n);
        }}
        onSuccess={(result) => {
          const paymentId = typeof result === 'string' ? result : result.paymentId;
          onSuccess(paymentId);
        }}
        onAuthDeclined={(info) => {
          onDeclined(info.message || 'Your card was declined. Please try a different card.');
        }}
      />
    </div>
  );
}
