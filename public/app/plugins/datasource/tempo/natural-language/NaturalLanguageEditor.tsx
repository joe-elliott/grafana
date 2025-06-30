import { css } from '@emotion/css';
import { useRef, useEffect } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { CodeEditor, Monaco, monacoTypes, useTheme2 } from '@grafana/ui';

import { TempoQuery } from '../types';
import { TempoDatasource } from '../datasource';
import { SimpleNaturalLanguageAutocomplete } from './SimpleNaturalLanguageAutocomplete';

interface Props {
  placeholder: string;
  query: TempoQuery;
  onChange: (val: TempoQuery) => void;
  onRunQuery: () => void;
  datasource: TempoDatasource;
  readOnly?: boolean;
}

export function NaturalLanguageEditor(props: Props) {
  const { query, onChange, onRunQuery, placeholder, datasource } = props;
  const theme = useTheme2();
  const styles = getStyles(theme, placeholder);

  // The Monaco Editor uses the first version of props.onChange in handleOnMount i.e. always has the initial
  // value of query because underlying Monaco editor is passed `query` below in the onEditorChange callback.
  // handleOnMount is called only once when the editor is mounted and does not get updates to query.
  // So we need useRef to get the latest version of query in the onEditorChange callback.
  const queryRef = useRef(query);
  queryRef.current = query;
  const onEditorChange = (value: string) => {
    onChange({ ...queryRef.current, query: value });
  };

  // work around the problem that `onEditorDidMount` is called once
  // and wouldn't get new version of onRunQuery
  const onRunQueryRef = useRef(onRunQuery);
  onRunQueryRef.current = onRunQuery;

  // Initialize language provider to load tags for autocomplete
  useEffect(() => {
    const initLanguageProvider = async () => {
      try {
        await datasource.languageProvider.start();
      } catch (error) {
        console.error('Failed to initialize language provider:', error);
      }
    };
    initLanguageProvider();
  }, [datasource]);

  // Create autocomplete provider
  const autocompleteProvider = useRef<SimpleNaturalLanguageAutocomplete | null>(null);
  if (!autocompleteProvider.current) {
    autocompleteProvider.current = new SimpleNaturalLanguageAutocomplete(datasource);
  }

  return (
    <CodeEditor
      value={query.query || ''}
      language={langId}
      onBlur={onEditorChange}
      onChange={onEditorChange}
      containerStyles={styles.queryField}
      readOnly={props.readOnly}
      monacoOptions={{
        folding: false,
        fontSize: 14,
        lineNumbers: 'off',
        overviewRulerLanes: 0,
        renderLineHighlight: 'none',
        scrollbar: {
          vertical: 'hidden',
          verticalScrollbarSize: 8, // used as "padding-right"
          horizontal: 'hidden',
          horizontalScrollbarSize: 0,
        },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      }}
      onBeforeEditorMount={ensureNaturalLanguageTraceQL}
      onEditorDidMount={(editor, monaco) => {
        if (!props.readOnly) {
          setupActions(editor, monaco, () => onRunQueryRef.current());
          setupPlaceholder(editor, monaco, styles);

          // Setup autocomplete
          if (autocompleteProvider.current && !autocompleteProviderRegistered) {
            autocompleteProvider.current.setEditor(monaco);
            monaco.languages.registerCompletionItemProvider(langId, autocompleteProvider.current);
            autocompleteProviderRegistered = true;
          }
        }

        // Apply theme based on Grafana theme
        const themeName = theme.isDark ? 'natural-language-traceql-dark-theme' : 'natural-language-traceql-theme';
        monaco.editor.setTheme(themeName);

        setupAutoSize(editor);
      }}
    />
  );
}

function setupPlaceholder(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco, styles: EditorStyles) {
  const placeholderDecorators = [
    {
      range: new monaco.Range(1, 1, 1, 1),
      options: {
        className: styles.placeholder,
        isWholeLine: true,
      },
    },
  ];

  let decorators: string[] = [];

  const checkDecorators = (): void => {
    const model = editor.getModel();

    if (!model) {
      return;
    }

    const newDecorators = model.getValueLength() === 0 ? placeholderDecorators : [];
    decorators = model.deltaDecorations(decorators, newDecorators);
  };

  checkDecorators();
  editor.onDidChangeModelContent(checkDecorators);
}

function setupActions(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco, onRunQuery: () => void) {
  editor.addAction({
    id: 'run-query',
    label: 'Run Query',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run: function () {
      onRunQuery();
    },
  });
}

function setupAutoSize(editor: monacoTypes.editor.IStandaloneCodeEditor) {
  const container = editor.getDomNode();
  const updateHeight = () => {
    if (container) {
      const contentHeight = Math.min(1000, editor.getContentHeight());
      const width = parseInt(container.style.width, 10);
      container.style.width = `${width}px`;
      container.style.height = `${contentHeight}px`;
      editor.layout({ width, height: contentHeight });
    }
  };
  editor.onDidContentSizeChange(updateHeight);
  updateHeight();
}

interface EditorStyles {
  placeholder: string;
  queryField: string;
}

// Language definition for syntax highlighting
const langId = 'natural-language-traceql';
let naturalLanguageTraceQLSetupDone = false;
let autocompleteProviderRegistered = false;

const scopes = ['event', 'instrumentation', 'link', 'resource', 'span', 'trace'];
const operators = ['=', '!=', '>', '<', '>=', '<=', '=~', '!~'];
const intrinsics = [
  'duration',
  'kind',
  'name',
  'rootName',
  'rootServiceName',
  'status',
  'statusMessage',
  'traceDuration',
  'event:name',
  'event:timeSinceStart',
  'instrumentation:name',
  'instrumentation:version',
  'link:spanID',
  'link:traceID',
  'span:duration',
  'span:id',
  'span:kind',
  'span:name',
  'span:status',
  'span:statusMessage',
  'span:parentID',
  'trace:duration',
  'trace:id',
  'trace:rootName',
  'trace:rootService',
];

const languageDefinition: monacoTypes.languages.IMonarchLanguage = {
  ignoreCase: false,
  defaultToken: '',
  tokenPostfix: '.natural-language-traceql',

  keywords: [...scopes, ...intrinsics],
  operators,

  symbols: /[=><!~?:&|+\-*\/^%@.]+/,
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  tokenizer: {
    root: [
      // Complete TraceQL expressions with scopes and intrinsics/attributes
      [/@(event|instrumentation|link|resource|span|trace):([a-zA-Z_][a-zA-Z0-9_]*)/, 'traceql-intrinsic'],
      [
        /@(event|instrumentation|link|resource|span|trace)\.([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/,
        'traceql-attribute',
      ],

      // Unscoped intrinsics and attributes
      [/@(duration|kind|name|rootName|rootServiceName|status|statusMessage|traceDuration)\b/, 'traceql-intrinsic'],
      [/@([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/, 'traceql-attribute'],

      // @ symbol by itself
      [/@/, 'operator'],

      // Operators
      [/[=!><]=?|[=!]~/, 'operator'],

      // Strings
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // Numbers
      [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, 'number'],

      // Durations
      [/\b\d+(\.\d+)?(us|µs|ns|ms|s|m|h)\b/, 'number'],

      // Whitespace
      [/\s+/, 'white'],

      // Everything else (normal text like "how often does")
      [/./, 'text'],
    ],
  },
};

function ensureNaturalLanguageTraceQL(monaco: Monaco) {
  if (!naturalLanguageTraceQLSetupDone) {
    naturalLanguageTraceQLSetupDone = true;
    monaco.languages.register({ id: langId });
    monaco.languages.setMonarchTokensProvider(langId, languageDefinition);

    // Define theme colors similar to TraceQL
    monaco.editor.defineTheme('natural-language-traceql-theme', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '666666' }, // Off-white/gray for normal text (tag names)
        { token: 'operator', foreground: '0099ff' }, // Blue for @ and operators
        { token: 'traceql-intrinsic', foreground: '00b8a3' }, // Tealier teal for intrinsics
        { token: 'traceql-attribute', foreground: '00b8a3' }, // Tealier teal for attributes
        { token: 'string', foreground: '00aa00' }, // Green for strings
        { token: 'number', foreground: 'ff6600' }, // Orange for numbers
      ],
      colors: {},
    });

    // Define dark theme colors
    monaco.editor.defineTheme('natural-language-traceql-dark-theme', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: 'cccccc' }, // Off-white for normal text (tag names)
        { token: 'operator', foreground: '5cb3ff' }, // Light blue for @ and operators
        { token: 'traceql-intrinsic', foreground: '4dd4bf' }, // Tealier light teal for intrinsics
        { token: 'traceql-attribute', foreground: '4dd4bf' }, // Tealier light teal for attributes
        { token: 'string', foreground: '88cc88' }, // Light green for strings
        { token: 'number', foreground: 'ff9966' }, // Light orange for numbers
      ],
      colors: {},
    });
  }
}

const getStyles = (theme: GrafanaTheme2, placeholder: string): EditorStyles => {
  return {
    queryField: css({
      borderRadius: theme.shape.radius.default,
      border: `1px solid ${theme.components.input.borderColor}`,
      flex: 1,
    }),
    placeholder: css({
      '::after': {
        content: `'${placeholder}'`,
        fontFamily: theme.typography.fontFamilyMonospace,
        opacity: 0.3,
      },
    }),
  };
};
