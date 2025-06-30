import { Monaco, monacoTypes } from '@grafana/ui';
import { TempoDatasource } from '../datasource';

const SCOPES = ['event', 'instrumentation', 'link', 'resource', 'span', 'trace'];

const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', '=~', '!~'];

// Scope-specific intrinsics for colon syntax (scope:intrinsic) - jpe - pull this from tempo
const SCOPE_INTRINSICS: Record<string, string[]> = {
  event: ['name', 'timeSinceStart'],
  instrumentation: ['name', 'version'],
  link: ['spanID', 'traceID'],
  resource: [], // Resource scope doesn't have intrinsics
  span: ['duration', 'id', 'kind', 'name', 'status', 'statusMessage', 'parentID'],
  trace: ['duration', 'id', 'rootName', 'rootService'],
};

export class SimpleNaturalLanguageAutocomplete implements monacoTypes.languages.CompletionItemProvider {
  private datasource: TempoDatasource;
  private monaco: Monaco | undefined;

  constructor(datasource: TempoDatasource) {
    this.datasource = datasource;
  }

  triggerCharacters = ['@', '.', ':', ' '];

  setEditor(monaco: Monaco) {
    this.monaco = monaco;
  }

  provideCompletionItems(
    model: monacoTypes.editor.ITextModel,
    position: monacoTypes.Position
  ): monacoTypes.languages.ProviderResult<monacoTypes.languages.CompletionList> {
    if (!this.monaco) {
      return { suggestions: [] };
    }

    const textUntilPosition = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });

    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };

    // Check what character triggered the completion
    const charBeforeCursor = textUntilPosition.slice(-1);
    const textBeforeCursor = textUntilPosition.slice(0, -1);

    // @ trigger - show scopes, intrinsics, and tags
    if (charBeforeCursor === '@') {
      return this.getScopeCompletions(range);
    }

    // . trigger - show tag completions after scope
    if (charBeforeCursor === '.') {
      const scopeMatch = textBeforeCursor.match(/@(\w+)$/);
      if (scopeMatch && SCOPES.includes(scopeMatch[1])) {
        return this.getTagCompletions(range, scopeMatch[1]);
      }
    }

    // : trigger - show intrinsic completions after scope
    if (charBeforeCursor === ':') {
      const scopeMatch = textBeforeCursor.match(/@(\w+)$/);
      if (scopeMatch && SCOPES.includes(scopeMatch[1])) {
        return this.getIntrinsicCompletions(range, scopeMatch[1]);
      }
    }

    // Space trigger - show operators
    if (charBeforeCursor === ' ') {
      // Check if we're after a tag (scope.tag), intrinsic (scope:intrinsic), or unscoped tag
      // Match patterns like: @resource.service.name, @span:duration, @duration, etc.
      const tagMatch = textBeforeCursor.match(/@(?:(\w+)\.[\w.]+|(\w+):[\w.]+|[\w.]+)$/);
      if (tagMatch) {
        return this.getOperatorCompletions(range);
      }
    }

    // After operators, show tag values
    const operatorMatch = textBeforeCursor.match(/@((?:\w+\.)?(?:\w+:)?[\w.]+)\s+(=|!=|>|<|>=|<=|=~|!~)\s*$/);
    if (operatorMatch) {
      const fullTagName = operatorMatch[1];
      return this.getTagValueCompletions(range, fullTagName);
    }

    return { suggestions: [] };
  }

  private getScopeCompletions(range: monacoTypes.IRange): monacoTypes.languages.CompletionList {
    const suggestions: monacoTypes.languages.CompletionItem[] = [];

    // Add scopes
    SCOPES.forEach((scope) => {
      suggestions.push({
        label: scope,
        kind: this.monaco!.languages.CompletionItemKind.Class,
        insertText: scope,
        range,
        detail: 'Scope',
        documentation: `${scope} scope for TraceQL queries`,
      });
    });

    return { suggestions };
  }

  private getTagCompletions(range: monacoTypes.IRange, scope: string): monacoTypes.languages.CompletionList {
    const suggestions: monacoTypes.languages.CompletionItem[] = [];

    try {
      const tags = this.datasource.languageProvider.getTraceqlAutocompleteTags(scope);
      tags.forEach((tag) => {
        suggestions.push({
          label: tag,
          kind: this.monaco!.languages.CompletionItemKind.Property,
          insertText: tag,
          range,
          detail: 'Tag',
          documentation: `${scope}.${tag}`,
        });
      });
    } catch (error) {
      console.warn('Could not load scoped tags for autocomplete:', error);
    }

    return { suggestions };
  }

  private getIntrinsicCompletions(range: monacoTypes.IRange, scope: string): monacoTypes.languages.CompletionList {
    const suggestions: monacoTypes.languages.CompletionItem[] = [];

    const intrinsics = SCOPE_INTRINSICS[scope] || [];
    intrinsics.forEach((intrinsic) => {
      suggestions.push({
        label: intrinsic,
        kind: this.monaco!.languages.CompletionItemKind.Keyword,
        insertText: intrinsic,
        range,
        detail: 'Intrinsic',
        documentation: `${scope}:${intrinsic} - Built-in TraceQL intrinsic field`,
      });
    });

    return { suggestions };
  }

  private getOperatorCompletions(range: monacoTypes.IRange): monacoTypes.languages.CompletionList {
    const suggestions: monacoTypes.languages.CompletionItem[] = [];

    OPERATORS.forEach((operator) => {
      suggestions.push({
        label: operator,
        kind: this.monaco!.languages.CompletionItemKind.Operator,
        insertText: operator + ' ',
        range,
        detail: 'Operator',
        documentation: `Comparison operator: ${operator}`,
      });
    });

    return { suggestions };
  }

  private async getTagValueCompletions(
    range: monacoTypes.IRange,
    tagName: string
  ): Promise<monacoTypes.languages.CompletionList> {
    const suggestions: monacoTypes.languages.CompletionItem[] = [];

    try {
      const tagValues = await this.datasource.languageProvider.getOptionsV2(tagName);
      tagValues.forEach((value) => {
        if (value.label) {
          const insertText = value.type === 'string' ? `"${value.label}"` : value.label;
          suggestions.push({
            label: value.label,
            kind: this.monaco!.languages.CompletionItemKind.Value,
            insertText,
            range,
            detail: 'Value',
            documentation: `Tag value: ${value.label}`,
          });
        }
      });
    } catch (error) {
      console.warn('Could not load tag values for autocomplete:', error);
    }

    return { suggestions };
  }
}
