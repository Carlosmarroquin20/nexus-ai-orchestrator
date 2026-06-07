import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

// React Flow base styles are imported before the design-system stylesheet so the
// `.react-flow` token overrides in globals.css take precedence over library defaults.
import '@xyflow/react/dist/style.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nexus AI Orchestrator',
  description:
    'Visual node-based debugger for multi-agent AI pipelines: trace execution, inspect payloads, and analyze latency, token, and cost telemetry.',
};

export const viewport: Viewport = {
  themeColor: '#0b1120',
  colorScheme: 'dark',
};

interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps): JSX.Element {
  // `suppressHydrationWarning` guards the statically-applied `dark` class against
  // future client-side theme reconciliation; fonts resolve to the system stack
  // declared in the Tailwind config until `--font-sans`/`--font-mono` are wired.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="font-sans">{children}</body>
    </html>
  );
}
