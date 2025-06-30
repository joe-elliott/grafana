import React, { useState, useEffect } from 'react';

import { CoreApp, QueryEditorProps, DataFrame, DataQueryRequest, dateTime } from '@grafana/data';
import { llm } from '@grafana/llm';
import { getBackendSrv } from '@grafana/runtime';
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
  onClearResults: () => void;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface ConversationItem {
  type: 'natural-language-text' | 'tool-call' | 'tool-result';
  content: string;
  toolName?: string;
  timestamp: number;
  dataFrame?: DataFrame;
}

const SYSTEM_PROMPT = `You are tasked with executing a single TraceQL query. The results will be displayed to the user and you should provide no summary of the results.

- DO NOT summarize the results of the query.
- Search results are not exhaustive and cannot be used to compplete conclusions about the time range. 
- Metrics queries are exhaustive and can be used to form complete conclusions about the time range.
- Be concise and to the point.
- If you are unsure, ask a question instead of making a guess.
- Always use the docs tools before attempting to write TraceQL.
- Use the attribute names and values tools to better understand the trace data if it will help you write a better query.
- All tool results are displayed to the user. Do not summarize or analyze the results.
- Execute the simplest query possible that meets the user's needs.
- If you receive a traceql error feel free to correct the query and try again.
- In the final response summarize why the query was chosen. Provide no analysis. This should be a few sentences at most.`;

// Helper function to safely stringify objects with circular references - jpe claude wrote this and i don't know why but it works
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeStringify = (obj: any, indent = 2): string => {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }
      return value;
    },
    indent
  );
};

export const NaturalLanguageQueryEditor: React.FC<NaturalLanguageQueryEditorProps> = ({
  query,
  onChange,
  onRunQuery,
  onClearResults,
  datasource,
}) => {
  const theme = useTheme2();
  const [naturalLanguageQuery, setNaturalLanguageQuery] = useState(query.llmQuery || '');
  const [llmHealth, setLLMHealth] = useState<LLMProviderHealthDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [currentlyExecuting, setCurrentlyExecuting] = useState<string>('');
  const [finalResponse, setFinalResponse] = useState<string>('');
  const [mcpTools, setMCPTools] = useState<MCPTool[]>([]);
  const [lastExecutedTraceQL, setLastExecutedTraceQL] = useState<string>('');

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

  useEffect(() => {
    const loadMCPTools = async () => {
      try {
        const response = await getBackendSrv().get(
          `/api/datasources/${datasource.instanceSettings.id}/resources/mcp/tools`
        );
        if (response && response.tools && Array.isArray(response.tools)) {
          setMCPTools(response.tools);
        }
      } catch (error) {
        console.error('Error loading MCP tools:', error);
      }
    };

    loadMCPTools();
  }, [datasource]);

  const handleQueryChange = (value: string) => {
    setNaturalLanguageQuery(value);
    onChange({
      ...query,
      llmQuery: value,
    });
  };

  // takes a list of MCPTools that came from Tempo and converts them to llm.Tool[]
  const buildMCPTools = (tools: MCPTool[]): llm.Tool[] => {
    let filteredTools = tools
      .filter((tool) => tool.name.startsWith('docs-')) // jpe - filter to docs only calls for now
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || `Call the ${tool.name} tool`,
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      }));

    // now add a tool to execute a TraceQL query
    filteredTools.push({
      type: 'function' as const,
      function: {
        name: 'exec-traceql',
        description: 'Execute a TraceQL query',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The TraceQL query to execute',
            },
          },
          required: ['query'],
        },
      },
    });

    // attribute names tool
    filteredTools.push({
      type: 'function' as const,
      function: {
        name: 'get-attribute-names',
        description: 'Get a list of available attribute names that can be used in TraceQL queries',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              description:
                'Optional scope to filter attributes by (span, resource, event, link, instrumentation). If not provided, returns all attributes.',
            },
          },
        },
      },
    });

    // attribute values tool
    filteredTools.push({
      type: 'function' as const,
      function: {
        name: 'get-attribute-values',
        description: 'Get a list of values for a fully scoped attribute name',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The attribute name to get values for (e.g. "span.http.method", "resource.service.name")',
            },
            filterQuery: { type: 'string', description: 'Filter query to apply to the attribute values' },
          },
          required: ['name'],
        },
      },
    });

    return filteredTools;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callMCPTool = async (toolName: string, parameters: any) => {
    if (toolName === 'exec-traceql') {
      // execute a traceql query, get the results and then execute the natural language query
      setLastExecutedTraceQL(parameters.query);
      let updatedQuery: TempoQuery = {
        ...query,
        queryType: 'traceql',
        query: parameters.query,
        refId: 'A',
      };

      let queryRequest: DataQueryRequest<TempoQuery> = {
        // jpe - super made up. how do we get time ranges and other things?
        requestId: 'natural-language-query',
        interval: '',
        intervalMs: 0,
        range: {
          from: dateTime(Date.now() - 3600000),
          to: dateTime(Date.now()),
          raw: { from: 'now-1h', to: 'now' },
        },
        scopedVars: {},
        targets: [updatedQuery],
        timezone: 'browser',
        app: CoreApp.Unknown,
        startTime: Date.now(),
      };

      const results = await datasource.query(queryRequest).toPromise();

      if (results?.error) {
        throw new Error(results.error.message);
      }

      if (results?.data) {
        // display results jpe
        onChange({
          ...query,
          queryType: 'llm',
          llmQueryResults: results,
        });
        onRunQuery();

        return { data: results.data };
      }

      throw new Error('No results returned from TraceQL query'); // jpe - ??
    }

    if (toolName === 'get-attribute-names') {
      let tags = await datasource.getTagKeys();

      if (parameters.scope) {
        tags = tags.filter((tag) => tag.text.startsWith(parameters.scope + '.'));
      }

      return { data: tags }; // jpe - clean up and simplify all responses
    }

    if (toolName === 'get-attribute-values') {
      const tags = await datasource.tagValuesQuery(parameters.name, parameters.filterQuery);
      return { data: tags };
    }

    try {
      const response = await getBackendSrv().post(`/api/ds/query`, {
        queries: [
          {
            refId: 'A',
            queryType: 'mcp',
            mcpTool: toolName,
            mcpParameters: parameters,
            datasource: {
              type: 'tempo',
              uid: datasource.uid,
            },
          },
        ],
      });

      // Extract the result from the data frame
      if (response.results && response.results.A && response.results.A.frames && response.results.A.frames.length > 0) {
        const frame = response.results.A.frames[0]; // jpe - assuming only one frame?
        return { data: frame.data, frame: frame };
      }

      return null;
    } catch (error) {
      console.error('Error calling MCP tool:', error);
      throw error;
    }
  };

  const handleRunQuery = async () => {
    if (!naturalLanguageQuery.trim()) {
      return;
    }

    setIsLoading(true);
    setConversation([]);
    setFinalResponse('');
    setCurrentlyExecuting('Starting conversation...');

    try {
      const tools = buildMCPTools(mcpTools);

      let messages: llm.Message[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: naturalLanguageQuery },
      ];

      let response = await llm.chatCompletions({
        model: llm.Model.LARGE,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Handle tool calls
      while (response.choices && response.choices[0]?.message?.tool_calls) {
        const message = response.choices[0].message;
        messages.push(message);

        // Execute each tool call
        for (const toolCall of message.tool_calls || []) {
          setCurrentlyExecuting(`Querying Tempo: ${toolCall.function.name}`);

          // Add tool call to conversation
          setConversation((prev) => [
            ...prev,
            {
              type: 'tool-call',
              content: `${toolCall.function.name}(${toolCall.function.arguments})`,
              toolName: toolCall.function.name,
              timestamp: Date.now(),
            },
          ]);

          try {
            const functionArgs = JSON.parse(toolCall.function.arguments);
            const toolResult = await callMCPTool(toolCall.function.name, functionArgs);

            // Add tool result to conversation
            setConversation((prev) => [
              ...prev,
              {
                type: 'tool-result',
                content: safeStringify(toolResult?.data || toolResult, 2),
                toolName: toolCall.function.name,
                timestamp: Date.now(),
                dataFrame: toolResult?.frame,
              },
            ]);

            messages.push({
              role: 'tool',
              content: safeStringify(toolResult), // jpe - toolResult.data? really we need a llm favorable format
              tool_call_id: toolCall.id,
            });
          } catch (error) {
            const errorResult = {
              error: 'Tool call failed',
              details: error instanceof Error ? error.message : 'Unknown error',
            };

            // Add error result to conversation
            setConversation((prev) => [
              ...prev,
              {
                type: 'tool-result',
                content: safeStringify(errorResult, 2),
                toolName: toolCall.function.name,
                timestamp: Date.now(),
              },
            ]);

            messages.push({
              role: 'tool',
              content: safeStringify(errorResult),
              tool_call_id: toolCall.id,
            });
          }
        }

        // Get next response from LLM
        const toolNames = message.tool_calls?.map((tc) => tc.function.name).join(', ') || '';
        setCurrentlyExecuting(`Getting LLM response (analyzing ${toolNames} results)...`);
        response = await llm.chatCompletions({
          model: llm.Model.LARGE,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        });
      }

      if (response.choices && response.choices[0]?.message?.content) {
        const finalMessage = response.choices[0].message.content!;
        setFinalResponse(finalMessage); // jpe - is this always the final response? wasn't there a "stop reason" or something i could check?
        setConversation((prev) => [
          ...prev,
          {
            type: 'natural-language-text',
            content: finalMessage,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (error) {
      console.error('Error calling LLM:', error);
      setConversation((prev) => [
        ...prev,
        {
          type: 'natural-language-text',
          content: 'Error: Failed to get response from LLM',
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
      setCurrentlyExecuting('');
    }
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
        <InlineField label="Natural Language Query" labelWidth={14} grow>
          <NaturalLanguageEditor
            placeholder="Enter your natural language query here (run with Shift+Enter)"
            query={{ ...query, query: naturalLanguageQuery }}
            onChange={(updatedQuery) => handleQueryChange(updatedQuery.query || '')}
            datasource={datasource}
            onRunQuery={() => handleRunQuery()}
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
      <InlineFieldRow>
        <Button onClick={handleRunQuery} variant="primary" disabled={isLoading || !naturalLanguageQuery.trim()}>
          {isLoading ? 'Processing...' : 'Run Query'}
        </Button>
        <Button
          onClick={() => {
            onClearResults();
            setFinalResponse('');
            setConversation([]);
          }}
          variant="secondary"
          style={{ marginLeft: 8 }}
        >
          Clear
        </Button>
      </InlineFieldRow>
      {finalResponse && (
        <div style={{ marginTop: theme.spacing(2) }}>
          <Alert severity="success" title="Natural Language Response">
            <div style={{ whiteSpace: 'pre-wrap' }}>{finalResponse}</div>
          </Alert>
        </div>
      )}
      {(conversation.length > 0 || currentlyExecuting) && (
        <div style={{ marginTop: theme.spacing(2) }}>
          <details>
            <summary style={{ cursor: 'pointer', color: theme.colors.text.primary, marginBottom: theme.spacing(1) }}>
              {currentlyExecuting || `Conversation (${conversation.length} items)`}
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
              {currentlyExecuting && `[${new Date().toLocaleTimeString()}] STATUS: ${currentlyExecuting}\n`}
            </pre>
          </details>
        </div>
      )}
    </>
  );
};
