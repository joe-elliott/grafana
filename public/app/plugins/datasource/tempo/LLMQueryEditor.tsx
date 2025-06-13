import React, { useState, useEffect } from 'react';

import { CoreApp, QueryEditorProps, DataFrame, toDataFrame, getDisplayProcessor, GrafanaTheme2 } from '@grafana/data';
import { openai as llm } from '@grafana/llm';
import { getBackendSrv } from '@grafana/runtime';
import { InlineField, InlineFieldRow, TextArea, Button, Alert, useTheme2, Table } from '@grafana/ui';

import { TempoDatasource } from './datasource';
import { TempoQuery } from './types';

interface LLMQueryEditorProps extends QueryEditorProps<TempoDatasource, TempoQuery> {
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
  type: 'llm-text' | 'tool-call' | 'tool-result';
  content: string;
  toolName?: string;
  timestamp: number;
  dataFrame?: DataFrame;
}

const SYSTEM_PROMPT = `You are an assistant to explore tracing data using Tempo's API. A variety of tools are provided to you to understand this data.

Current date/time: ${new Date().toLocaleString()}

- Be concise and to the point.
- If you are unsure, ask a question instead of making a guess.
- If you are asked to do something that is not in the tools provided, say so.
- Be quick to use the docs tools before attempting to write TraceQL.
- Use the attribute names and values tools to better understand the trace data before writing TraceQL.
- All tool results are displayed to the user. Please summarize and analyze but no need to repeat the tool result.
- If the user asks questions about dependencies or call graphs, use TraceQL structural operators to answer the question.
- If the users asks for patterns, use metrics instead of search. Only use search if the user is looking for specific traces.`;

const renderDataFrame = (frame: DataFrame, theme: GrafanaTheme2) => {
  console.log('frame', frame);
  const dataFrame = toDataFrame(frame);
  console.log('dataFrame', dataFrame);

  if (!dataFrame || !dataFrame.fields || dataFrame.fields.length === 0) {
    return null;
  }

  const rowCount = dataFrame.length;

  if (rowCount === 0) {
    return <div style={{ fontStyle: 'italic', color: '#888' }}>No data</div>;
  }

  // Add display processors to fields for proper value rendering
  const processedDataFrame = {
    ...dataFrame,
    fields: dataFrame.fields.map((field) => ({
      ...field,
      display: field.display || getDisplayProcessor({ field, theme }),
    })),
  };

  return (
    <div style={{ maxHeight: '400px', overflow: 'auto', marginTop: '8px' }}>
      <Table data={processedDataFrame} width={800} height={Math.min(400, (rowCount + 1) * 32)} />
    </div>
  );
};

export const LLMQueryEditor: React.FC<LLMQueryEditorProps> = ({
  query,
  onChange,
  onRunQuery,
  onClearResults,
  datasource,
}) => {
  const theme = useTheme2();
  const [llmQuery, setLlmQuery] = useState(query.llmQuery || '');
  const [isLLMEnabled, setIsLLMEnabled] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [mcpTools, setMCPTools] = useState<MCPTool[]>([]);

  useEffect(() => {
    const checkLLMStatus = async () => {
      try {
        const enabled = await llm.enabled();
        setIsLLMEnabled(enabled);
      } catch (error) {
        console.error('Error checking LLM plugin status:', error);
        setIsLLMEnabled(false);
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
    setLlmQuery(value);
    onChange({
      ...query,
      llmQuery: value,
    });
  };

  const convertMCPToolsToOpenAI = (tools: MCPTool[]): llm.Tool[] => {
    return tools.map((tool) => ({
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
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callMCPTool = async (toolName: string, parameters: any) => {
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
    if (!llmQuery.trim()) {
      return;
    }

    setIsLoading(true);
    setConversation([]);

    try {
      const tools = convertMCPToolsToOpenAI(mcpTools);

      let messages: llm.Message[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: llmQuery },
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
                content: JSON.stringify(toolResult?.data || toolResult, null, 2),
                toolName: toolCall.function.name,
                timestamp: Date.now(),
                dataFrame: toolResult?.frame,
              },
            ]);

            messages.push({
              role: 'tool',
              content: JSON.stringify(toolResult), // jpe - toolResult.data? really we need a llm favorable format
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
                content: JSON.stringify(errorResult, null, 2),
                toolName: toolCall.function.name,
                timestamp: Date.now(),
              },
            ]);

            messages.push({
              role: 'tool',
              content: JSON.stringify(errorResult),
              tool_call_id: toolCall.id,
            });
          }
        }

        // Get next response from LLM
        response = await llm.chatCompletions({
          model: llm.Model.LARGE,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        });
      }

      if (response.choices && response.choices[0]?.message?.content) {
        setConversation((prev) => [
          ...prev,
          {
            type: 'llm-text',
            content: response.choices[0].message.content!,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (error) {
      console.error('Error calling LLM:', error);
      setConversation((prev) => [
        ...prev,
        {
          type: 'llm-text',
          content: 'Error: Failed to get response from LLM',
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLLMEnabled === null) {
    return <div>Checking LLM availability...</div>;
  }

  if (isLLMEnabled === false) {
    return (
      <Alert severity="warning" title="LLM Plugin Required">
        The Grafana LLM plugin is not installed or configured. Please install and configure the grafana-llm-app plugin
        to use this feature.
      </Alert>
    );
  }

  return (
    <>
      <InlineFieldRow>
        <InlineField label="LLM Query" labelWidth={14} grow>
          <TextArea
            value={llmQuery}
            onChange={(e) => handleQueryChange(e.currentTarget.value)}
            placeholder="Enter your natural language query here..."
            rows={4}
          />
        </InlineField>
      </InlineFieldRow>
      <InlineFieldRow>
        <Button onClick={handleRunQuery} variant="primary" disabled={isLoading || !llmQuery.trim()}>
          {isLoading ? 'Processing...' : 'Run Query'}
        </Button>
        <Button onClick={onClearResults} variant="secondary" style={{ marginLeft: 8 }}>
          Clear
        </Button>
      </InlineFieldRow>
      {conversation.length > 0 && (
        <div style={{ marginTop: theme.spacing(2) }}>
          <h4 style={{ color: theme.colors.text.primary, marginBottom: theme.spacing(2) }}>Conversation</h4>
          {conversation.map((item, index) => {
            const getTypeStyles = () => {
              switch (item.type) {
                case 'llm-text':
                  return {
                    borderColor: theme.colors.success.border,
                    backgroundColor: theme.colors.success.transparent,
                    headerColor: theme.colors.success.text,
                    icon: '🤖',
                    label: 'LLM Response',
                  };
                case 'tool-call':
                  return {
                    borderColor: theme.colors.info.border,
                    backgroundColor: theme.colors.info.transparent,
                    headerColor: theme.colors.info.text,
                    icon: '🔧',
                    label: `Tool Call: ${item.toolName}`,
                  };
                case 'tool-result':
                  return {
                    borderColor: theme.colors.warning.border,
                    backgroundColor: theme.colors.warning.transparent,
                    headerColor: theme.colors.warning.text,
                    icon: '📋',
                    label: `Tool Result: ${item.toolName}`,
                  };
                default:
                  return {
                    borderColor: theme.colors.border.medium,
                    backgroundColor: theme.colors.background.secondary,
                    headerColor: theme.colors.text.primary,
                    icon: '',
                    label: '',
                  };
              }
            };

            const typeStyles = getTypeStyles();

            return (
              <div
                key={index}
                style={{
                  marginBottom: theme.spacing(1.5),
                  padding: theme.spacing(1.5),
                  borderRadius: theme.shape.radius.default,
                  border: `1px solid ${typeStyles.borderColor}`,
                  backgroundColor: typeStyles.backgroundColor,
                }}
              >
                <div
                  style={{
                    fontWeight: theme.typography.fontWeightMedium,
                    marginBottom: theme.spacing(1),
                    color: typeStyles.headerColor,
                    fontSize: theme.typography.bodySmall.fontSize,
                  }}
                >
                  {typeStyles.icon} {typeStyles.label}
                </div>
                {item.type === 'tool-result' && item.dataFrame ? (
                  <>
                    <div style={{ marginBottom: '8px' }}>
                      <strong>Data Results ({item.dataFrame.length} rows):</strong>
                    </div>
                    {renderDataFrame(item.dataFrame, theme)}
                    <details style={{ marginTop: '8px' }}>
                      <summary style={{ cursor: 'pointer', color: theme.colors.text.secondary }}>Raw Data</summary>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          margin: '8px 0 0 0',
                          fontFamily: theme.typography.code.fontFamily,
                          fontSize: theme.typography.bodySmall.fontSize,
                          color: theme.colors.text.primary,
                          lineHeight: theme.typography.body.lineHeight,
                          backgroundColor: theme.colors.background.primary,
                          padding: '8px',
                          borderRadius: '4px',
                          maxHeight: '200px',
                          overflow: 'auto',
                        }}
                      >
                        {item.content}
                      </pre>
                    </details>
                  </>
                ) : (
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      margin: 0,
                      fontFamily:
                        item.type === 'llm-text' ? theme.typography.body.fontFamily : theme.typography.code.fontFamily,
                      fontSize:
                        item.type === 'llm-text' ? theme.typography.body.fontSize : theme.typography.bodySmall.fontSize,
                      color: theme.colors.text.primary,
                      lineHeight: theme.typography.body.lineHeight,
                    }}
                  >
                    {item.content}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};
