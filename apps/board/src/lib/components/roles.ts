import {
  Bot,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Hammer,
  ListChecks,
  MessagesSquare,
  ShieldCheck
} from '@lucide/svelte';

export const ROLE_ICONS = {
  interviewer: MessagesSquare,
  spec: FileText,
  builder: Hammer,
  reviewer_spec: ListChecks,
  reviewer_correctness: ShieldCheck,
  chooser: ClipboardCheck,
  learner: GraduationCap
} as const;

export const roleIcon = (role: string) => ROLE_ICONS[role as keyof typeof ROLE_ICONS] ?? Bot;

export const roleColor = (role: string) => `var(--role-${role}, var(--text-2))`;
