import js from '@eslint/js';
import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * ESLint 9 扁平配置
 * 等价于 .eslintrc.cjs 中的配置，适配 ESLint 9+ 的 flat config 格式
 */
export default [
  /** 全局忽略目录 */
  {
    ignores: ['dist/**', 'node_modules/**', 'server/**', '*.js', '*.cjs'],
  },

  /** 基础推荐规则 + TypeScript 配置 */
  {
    ...js.configs.recommended,
    files: ['src/**/*.{ts,tsx}'],
  },

  /** TypeScript 专用规则配置 */
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.es2020,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      /** 继承 @typescript-eslint/recommended 规则 */
      ...tseslint.configs.recommended.rules,

      /** 关闭 no-undef，TypeScript 编译器已处理未定义变量检查 */
      'no-undef': 'off',

      /** 允许空 catch 块 */
      'no-empty': ['error', { allowEmptyCatch: true }],

      /** 禁止 console.log/info，允许 console.warn/error */
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      /** TypeScript any 类型使用警告 */
      '@typescript-eslint/no-explicit-any': 'warn',

      /** 未使用变量报错，下划线前缀参数忽略 */
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      /** 不强制函数返回类型声明 */
      '@typescript-eslint/explicit-function-return-type': 'off',

      /** 允许非空断言 */
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /** Prettier 兼容配置（必须放在最后） */
  eslintConfigPrettier,
];
