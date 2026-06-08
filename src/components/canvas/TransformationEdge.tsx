'use client';

import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { memo } from 'react';

import type { NexusEdge } from '@/types/graph';

/**
 * Custom edge renderer. Draws a bezier dependency path and, for non-passthrough
 * transformations, a mid-path label naming the transform kind. Control edges
 * (ordering-only, no payload) render dashed to distinguish them from data edges.
 */
export const TransformationEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    data,
  }: EdgeProps<NexusEdge>): JSX.Element => {
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });

    const isControlEdge = data?.dependencyKind === 'control';
    const transformKind = data?.transformation.kind ?? 'passthrough';

    return (
      <>
        <BaseEdge
          id={id}
          path={path}
          {...(markerEnd !== undefined ? { markerEnd } : {})}
          {...(isControlEdge ? { style: { strokeDasharray: '6 4' } } : {})}
        />
        {transformKind !== 'passthrough' ? (
          <EdgeLabelRenderer>
            <div
              className="pointer-events-none absolute rounded border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-popover-foreground shadow-sm"
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            >
              {transformKind}
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    );
  },
);
TransformationEdge.displayName = 'TransformationEdge';
