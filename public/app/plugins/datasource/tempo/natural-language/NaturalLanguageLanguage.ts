import type { languages } from 'monaco-editor';

const SCOPES = ['event', 'instrumentation', 'link', 'resource', 'span'];
const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', '=~', '!~'];

const language: languages.IMonarchLanguage = {
  ignoreCase: false,
  defaultToken: '',
  tokenPostfix: '.natural-language',

  scopes: SCOPES,
  operators: OPERATORS,

  tokenizer: {
    root: [
      // @ symbol followed by scope and tag
      [/@(\w+)\.([\w.]+)/, ['keyword', 'keyword', 'tag']],

      // @ symbol followed by intrinsic or simple tag
      [/@([\w.]+)/, ['keyword', 'tag']],

      // @ symbol alone
      [/@/, 'keyword'],

      // Operators (=, !=, etc.)
      [
        /[=!<>~]+/,
        {
          cases: {
            '@operators': 'delimiter',
            '@default': '',
          },
        },
      ],

      // Quoted strings (values)
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // Numbers
      [/\d+(\.\d+)?/, 'number'],

      // Regular text (everything else)
      [/[a-zA-Z_][\w]*/, 'identifier'],

      // Whitespace
      [/\s+/, ''],

      // Everything else
      [/./, ''],
    ],
  },
};

export const naturalLanguageLanguageDefinition = {
  id: 'natural-language',
  extensions: ['.natural-language'],
  aliases: ['natural-language'],
  mimetypes: [],
  def: {
    language,
    languageConfiguration: {
      brackets: [
        ['"', '"'],
        ["'", "'"],
      ],
      autoClosingPairs: [
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
      surroundingPairs: [
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
    },
  },
};
