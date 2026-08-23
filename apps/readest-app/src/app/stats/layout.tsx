import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'My Reading',
  description: 'Your reading statistics: total time, monthly charts, and top books.',
};

export default function StatsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
