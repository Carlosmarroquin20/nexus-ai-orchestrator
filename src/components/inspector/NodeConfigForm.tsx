'use client';

import { useGraphActions, useNexusNodes } from '@/store/useGraphStore';
import {
  NODE_KIND,
  asNodeId,
  type LlmProvider,
  type NexusNode,
  type NodeId,
  type SimilarityMetric,
  type VectorStoreProvider,
} from '@/types/graph';

import {
  NumberField,
  type SelectOption,
  SelectField,
  StringListField,
  TextAreaField,
  TextField,
} from './fields';

/* Enum option registries. Typed against the domain unions so an invalid literal
 * is rejected at compile time (exhaustiveness against the union is not enforced). */
const LLM_PROVIDERS: readonly SelectOption<LlmProvider>[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'self_hosted', label: 'Self-hosted' },
];

const VECTOR_PROVIDERS: readonly SelectOption<VectorStoreProvider>[] = [
  { value: 'pinecone', label: 'Pinecone' },
  { value: 'weaviate', label: 'Weaviate' },
  { value: 'qdrant', label: 'Qdrant' },
  { value: 'pgvector', label: 'pgvector' },
];

const SIMILARITY_METRICS: readonly SelectOption<SimilarityMetric>[] = [
  { value: 'cosine', label: 'Cosine' },
  { value: 'dot_product', label: 'Dot product' },
  { value: 'euclidean', label: 'Euclidean' },
];

const UNBOUND = '';

interface LlmCoreRefFieldProps {
  readonly label: string;
  readonly value: NodeId | null;
  readonly onChange: (value: NodeId | null) => void;
}

/**
 * Binds an agent/classifier to an LLM_CORE node. Options are derived live from
 * the graph's LLM_CORE nodes. Subscribes to the full node array, so during an
 * active run this field re-renders on telemetry ticks; acceptable since editing
 * is an interactive, low-frequency action.
 */
const LlmCoreRefField = ({ label, value, onChange }: LlmCoreRefFieldProps): JSX.Element => {
  const nodes = useNexusNodes();
  const options: readonly SelectOption<string>[] = [
    { value: UNBOUND, label: 'Unbound' },
    ...nodes
      .filter((node) => node.data.kind === NODE_KIND.LLM_CORE)
      .map((node) => ({ value: node.id, label: node.data.label })),
  ];
  return (
    <SelectField
      label={label}
      value={value ?? UNBOUND}
      options={options}
      onChange={(next) => onChange(next === UNBOUND ? null : asNodeId(next))}
    />
  );
};

/**
 * Renders the variant-specific fields. `node.data` narrows on `kind`, so each
 * branch operates on a precisely-typed config; the `never` default enforces
 * exhaustiveness if a node variant is ever added without a corresponding form.
 */
const NodeConfigFields = ({ node }: { readonly node: NexusNode }): JSX.Element => {
  const { setNodeConfig } = useGraphActions();
  const nodeId = asNodeId(node.id);

  switch (node.data.kind) {
    case NODE_KIND.AGENT: {
      const cfg = node.data.config;
      const patch = (next: Partial<typeof cfg>): void => setNodeConfig(nodeId, { ...cfg, ...next });
      return (
        <>
          <TextAreaField
            label="System prompt"
            value={cfg.systemPrompt}
            rows={4}
            onChange={(systemPrompt) => patch({ systemPrompt })}
          />
          <StringListField label="Tools" value={cfg.toolNames} onChange={(toolNames) => patch({ toolNames })} />
          <NumberField
            label="Max iterations"
            value={cfg.maxIterations}
            min={1}
            step={1}
            onChange={(maxIterations) => patch({ maxIterations })}
          />
          <LlmCoreRefField label="LLM core" value={cfg.llmCoreRef} onChange={(llmCoreRef) => patch({ llmCoreRef })} />
        </>
      );
    }
    case NODE_KIND.LLM_CORE: {
      const cfg = node.data.config;
      const patch = (next: Partial<typeof cfg>): void => setNodeConfig(nodeId, { ...cfg, ...next });
      return (
        <>
          <SelectField label="Provider" value={cfg.provider} options={LLM_PROVIDERS} onChange={(provider) => patch({ provider })} />
          <TextField label="Model" value={cfg.model} onChange={(model) => patch({ model })} />
          <NumberField label="Temperature" value={cfg.temperature} min={0} max={2} step={0.1} onChange={(temperature) => patch({ temperature })} />
          <NumberField label="Max output tokens" value={cfg.maxOutputTokens} min={1} step={1} onChange={(maxOutputTokens) => patch({ maxOutputTokens })} />
          <NumberField label="Top P" value={cfg.topP} min={0} max={1} step={0.05} onChange={(topP) => patch({ topP })} />
        </>
      );
    }
    case NODE_KIND.PROMPT_TEMPLATE: {
      const cfg = node.data.config;
      const patch = (next: Partial<typeof cfg>): void => setNodeConfig(nodeId, { ...cfg, ...next });
      return (
        <>
          <TextAreaField label="Template" value={cfg.template} rows={5} onChange={(template) => patch({ template })} />
          <StringListField label="Input variables" value={cfg.inputVariables} onChange={(inputVariables) => patch({ inputVariables })} />
          <TextField label="Version" value={cfg.version} onChange={(version) => patch({ version })} />
        </>
      );
    }
    case NODE_KIND.CLASSIFIER: {
      const cfg = node.data.config;
      const patch = (next: Partial<typeof cfg>): void => setNodeConfig(nodeId, { ...cfg, ...next });
      return (
        <>
          <StringListField label="Labels" value={cfg.labels} onChange={(labels) => patch({ labels })} />
          <NumberField
            label="Confidence threshold"
            value={cfg.confidenceThreshold}
            min={0}
            max={1}
            step={0.05}
            onChange={(confidenceThreshold) => patch({ confidenceThreshold })}
          />
          <LlmCoreRefField label="LLM core" value={cfg.llmCoreRef} onChange={(llmCoreRef) => patch({ llmCoreRef })} />
        </>
      );
    }
    case NODE_KIND.VECTOR_DB: {
      const cfg = node.data.config;
      const patch = (next: Partial<typeof cfg>): void => setNodeConfig(nodeId, { ...cfg, ...next });
      return (
        <>
          <SelectField label="Provider" value={cfg.provider} options={VECTOR_PROVIDERS} onChange={(provider) => patch({ provider })} />
          <TextField label="Index name" value={cfg.indexName} onChange={(indexName) => patch({ indexName })} />
          <TextField label="Embedding model" value={cfg.embeddingModel} onChange={(embeddingModel) => patch({ embeddingModel })} />
          <NumberField label="Top K" value={cfg.topK} min={1} step={1} onChange={(topK) => patch({ topK })} />
          <SelectField
            label="Similarity metric"
            value={cfg.similarityMetric}
            options={SIMILARITY_METRICS}
            onChange={(similarityMetric) => patch({ similarityMetric })}
          />
        </>
      );
    }
    default: {
      const _exhaustive: never = node.data;
      return <>{_exhaustive}</>;
    }
  }
};

/** Editable node configuration: the common label plus variant-specific fields. */
export const NodeConfigForm = ({ node }: { readonly node: NexusNode }): JSX.Element => {
  const { setNodeLabel } = useGraphActions();
  const nodeId = asNodeId(node.id);

  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Configuration
      </h4>
      <TextField label="Label" value={node.data.label} onChange={(label) => setNodeLabel(nodeId, label)} />
      <NodeConfigFields node={node} />
    </section>
  );
};
