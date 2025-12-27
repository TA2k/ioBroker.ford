const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    ignores: [
      '**/.eslintrc.js',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**'
    ]
  },
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'commonjs',
      globals: {
        ...globals.es6,
        ...globals.node,
        ...globals.mocha
      }
    },
    rules: {
      'indent': [
        'error',
        2,
        {
          'SwitchCase': 1
        }
      ],
      'no-console': 'off',
      'no-var': 'error',
      'no-trailing-spaces': 'error',
      'prefer-const': 'error',
      'quotes': [
        'error',
        'single',
        {
          'avoidEscape': true,
          'allowTemplateLiterals': true
        }
      ],
      'semi': [
        'error',
        'always'
      ]
    }
  }
];
