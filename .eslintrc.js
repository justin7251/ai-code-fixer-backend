module.exports = {
    root: true,
    env: {
        es6: true,
        node: true,
    },
    extends: [
        'eslint:recommended',
    ],
    rules: {
        'max-len': ['error', {
            'code': 120,
            'ignoreUrls': true,
        }],
        'indent': ['error', 4],
        'object-curly-spacing': ['error', 'never'],
        'comma-dangle': ['error', 'always-multiline'],
        'no-unused-vars': ['warn', {
            'argsIgnorePattern': '^_',
            'varsIgnorePattern': '^_',
            'caughtErrorsIgnorePattern': '^_',
        }],
        'semi': ['error', 'always'],
    },
    overrides: [
        {
            files: ['**/*.spec.*'],
            env: {
                mocha: true,
            },
            rules: {},
        },
    ],
    parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'commonjs',
    },
};
