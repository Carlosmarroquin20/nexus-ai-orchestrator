import { ScrollArea } from '@/components/ui/scroll-area';

/** Serializes a payload defensively; cyclic or non-serializable graphs degrade gracefully. */
const stringifyPayload = (payload: Record<string, unknown>): string => {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '[unserializable payload]';
  }
};

export interface PayloadViewerProps {
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

/** Read-only, scrollable JSON view of a node payload buffer. */
export const PayloadViewer = ({ title, payload }: PayloadViewerProps): JSX.Element => {
  const isEmpty = Object.keys(payload).length === 0;

  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <ScrollArea className="max-h-48 rounded-md border border-border bg-muted/40">
        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-foreground">
          {isEmpty ? <span className="text-muted-foreground">Empty buffer</span> : stringifyPayload(payload)}
        </pre>
      </ScrollArea>
    </section>
  );
};
