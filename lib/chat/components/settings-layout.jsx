'use client';

import { useState, useEffect } from 'react';
import { PageLayout } from './page-layout.js';
import { UserIcon, ClockIcon, ZapIcon, MessageIcon, GitBranchIcon, SettingsIcon, RunnersIcon } from './icons.js';

const TABS = [
  { id: 'event-handler', label: 'Event Handler', href: '/admin/event-handler', icon: MessageIcon },
  { id: 'github', label: 'GitHub', href: '/admin/github', icon: GitBranchIcon },
  { id: 'nodes', label: 'Nodes', href: '/admin/nodes', icon: RunnersIcon },
  { id: 'users', label: 'Users', href: '/admin/users', icon: UserIcon },
  { id: 'crons', label: 'Crons', href: '/admin/crons', icon: ClockIcon },
  { id: 'triggers', label: 'Triggers', href: '/admin/triggers', icon: ZapIcon },
  { id: 'general', label: 'General', href: '/admin/general', icon: SettingsIcon },
];

export function SettingsLayout({ session, children }) {
  const [activePath, setActivePath] = useState('');

  useEffect(() => {
    setActivePath(window.location.pathname);
  }, []);

  return (
    <PageLayout session={session}>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Admin</h1>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-border mb-6 overflow-x-auto scrollbar-hide max-w-full">
        {TABS.map((tab) => {
          const isActive = activePath === tab.href || activePath.startsWith(tab.href + '/');
          const Icon = tab.icon;
          return (
            <a
              key={tab.id}
              href={tab.href}
              className={`inline-flex items-center gap-2 px-3 py-2 min-h-[44px] shrink-0 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </a>
          );
        })}
      </div>

      {/* Tab content */}
      {children}
    </PageLayout>
  );
}
