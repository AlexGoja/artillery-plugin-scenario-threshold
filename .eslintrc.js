const sasConfig = require('@sky-uk-ott/ott-sas-scripts/eslintrc');

sasConfig.overrides.forEach((override) => {
  override.rules = {
    ...override.rules,
    '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'as' }],
  };
});

const SamsungAdapterOverrides = [
  {
    plugins: ['check-file'],
    files: ['**/*.*'],
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        {
          '**/*.{ts,tsx,js,jsx}': 'CAMEL_CASE',
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],
      'check-file/folder-naming-convention': [
        'error',
        {
          'src/**/': 'CAMEL_CASE',
          'playwright/**/': 'CAMEL_CASE',
          'test/**/': 'CAMEL_CASE',
        },
      ],
    },
  },
];

module.exports = sasConfig;

sasConfig.overrides.push(...SamsungAdapterOverrides);
