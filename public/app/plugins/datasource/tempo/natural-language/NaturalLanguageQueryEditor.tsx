import React, { useState, useEffect } from 'react';

import { CoreApp, QueryEditorProps } from '@grafana/data';
import { llm } from '@grafana/llm';
import { InlineField, InlineFieldRow, TextArea, Button, Alert, useTheme2 } from '@grafana/ui';

import { TempoDatasource } from '../datasource';
import { TempoQuery } from '../types';

import { NaturalLanguageEditor } from './NaturalLanguageEditor';

interface LLMProviderHealthDetails {
  enabled: boolean;
  message: string;
}

interface NaturalLanguageQueryEditorProps extends QueryEditorProps<TempoDatasource, TempoQuery> {
  app?: CoreApp;
  lastExecutedTraceQL?: string;
  conversation?: ConversationItem[];
  finalResponse?: string;
}

interface ConversationItem {
  type: 'natural-language-text' | 'tool-call' | 'tool-result';
  content: string;
  toolName?: string;
  timestamp: number;
}

export const NaturalLanguageQueryEditor: React.FC<NaturalLanguageQueryEditorProps> = ({
  query,
  onChange,
  onRunQuery,
  datasource,
  lastExecutedTraceQL = '',
  conversation = [],
  finalResponse = '',
}) => {
  const theme = useTheme2();
  const [llmHealth, setLLMHealth] = useState<LLMProviderHealthDetails | null>(null);

  console.log('NaturalLanguageQueryEditor - Props:', {
    // Debug
    lastExecutedTraceQL,
    conversation,
    finalResponse,
    query,
  });

  useEffect(() => {
    const checkLLMStatus = async () => {
      try {
        const health = await llm.health();

        if (health.ok && health.configured) {
          setLLMHealth({
            enabled: true,
            message: 'LLM is healthy',
          });
          return;
        }

        if (!health.configured) {
          setLLMHealth({
            enabled: false,
            message: 'LLM is not configured: ' + health.error,
          });
          return;
        }

        if (!health.ok) {
          setLLMHealth({
            enabled: false,
            message: 'Unexpected error connecting to LLM: ' + health.error,
          });
          return;
        }
      } catch (error) {
        setLLMHealth({
          enabled: false,
          message: 'Unexpected error checking LLM plugin status ' + error,
        });
      }
    };

    checkLLMStatus();
  }, []);

  const handleQueryChange = (value: string) => {
    onChange({
      ...query,
      llmQuery: value,
    });
  };

  if (llmHealth === null) {
    return <div>Checking LLM availability...</div>;
  }

  if (llmHealth.enabled === false) {
    return (
      <Alert severity="warning" title="LLM Plugin Required">
        The Grafana LLM plugin is not installed or configured. Please install and configure the grafana-llm-app plugin
        to use this feature.
        <br />
        {llmHealth.message}
      </Alert>
    );
  }

  return (
    <>
      <InlineFieldRow>
        <InlineField label="Ask Anything" labelWidth={14} grow>
          <NaturalLanguageEditor
            placeholder="Enter your natural language query here (run with Shift+Enter)"
            query={query}
            onChange={(updatedQuery) => handleQueryChange(updatedQuery.query || '')}
            datasource={datasource}
            onRunQuery={onRunQuery}
          />
        </InlineField>
      </InlineFieldRow>
      <InlineFieldRow>
        <InlineField label="TraceQL" labelWidth={14} grow>
          <TextArea
            value={lastExecutedTraceQL}
            readOnly
            rows={1}
            style={{ fontFamily: 'monospace', fontSize: '16px' }}
          />
        </InlineField>
        {lastExecutedTraceQL && (
          <Button
            onClick={() => {
              onChange({
                ...query,
                queryType: 'traceql',
                query: lastExecutedTraceQL,
              });
              onRunQuery();
            }}
            variant="secondary"
            size="sm"
            style={{ marginLeft: 8 }}
          >
            Execute in TraceQL
          </Button>
        )}
      </InlineFieldRow>
      {finalResponse && (
        <div style={{ marginTop: theme.spacing(2) }}>
          <Alert severity="success" title="Natural Language Response">
            <div style={{ whiteSpace: 'pre-wrap' }}>{finalResponse}</div>
          </Alert>
        </div>
      )}
      {conversation.length > 0 && (
        <div style={{ marginTop: theme.spacing(2) }}>
          <details>
            <summary style={{ cursor: 'pointer', color: theme.colors.text.primary, marginBottom: theme.spacing(1) }}>
              {`Conversation (${conversation.length} items)`}
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                margin: 0,
                fontFamily: theme.typography.code.fontFamily,
                fontSize: theme.typography.bodySmall.fontSize,
                color: theme.colors.text.primary,
                lineHeight: theme.typography.body.lineHeight,
                backgroundColor: theme.colors.background.secondary,
                padding: theme.spacing(1),
                borderRadius: theme.shape.radius.default,
                maxHeight: '400px',
                overflow: 'auto',
                border: `1px solid ${theme.colors.border.medium}`,
              }}
            >
              {conversation
                .map((item, index) => {
                  const timestamp = new Date(item.timestamp).toLocaleTimeString();
                  const typeLabel =
                    item.type === 'natural-language-text'
                      ? 'NATURAL LANGUAGE'
                      : item.type === 'tool-call'
                        ? 'TOOL CALL'
                        : 'TOOL RESULT';
                  const prefix = `[${timestamp}] ${typeLabel}${item.toolName ? ` (${item.toolName})` : ''}:`;
                  const truncatedContent =
                    item.content.length > 1000 ? item.content.substring(0, 1000) + '\n... (truncated)' : item.content;
                  return `${prefix}\n${truncatedContent}\n\n`;
                })
                .join('')}
            </pre>
          </details>
        </div>
      )}
    </>
  );
};
