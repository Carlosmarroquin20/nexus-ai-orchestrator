import { Bot, Cpu, Database, FileText, GitBranch, type LucideIcon } from 'lucide-react';

import { type NodeKindIcon, getNodeDescriptor } from '@/config/nodeRegistry';
import type { NexusNodeKind } from '@/types/graph';

/** Resolves the registry's icon identifiers to concrete lucide components. */
export const NODE_ICONS: Readonly<Record<NodeKindIcon, LucideIcon>> = {
  bot: Bot,
  cpu: Cpu,
  database: Database,
  'file-text': FileText,
  'git-branch': GitBranch,
};

/** Convenience accessor mapping a node kind directly to its icon component. */
export const getNodeIcon = (kind: NexusNodeKind): LucideIcon =>
  NODE_ICONS[getNodeDescriptor(kind).icon];
