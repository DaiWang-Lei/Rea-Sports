import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 纯逻辑层：不允许依赖 three.js / DOM / 浏览器专用模块（同时由 tsconfig.sim.json 做类型层面的约束）
const PURE_LAYERS = [
  'src/core/**',
  'src/sim/**',
  'src/config/tuning.ts',
  'src/config/difficulty.ts',
  'src/config/rules.ts',
  'src/input/types.ts',
  'src/input/clock/**',
  'src/input/fusion/**',
  'src/input/paddle/**',
  'src/input/joycon/protocol.ts',
  'src/input/joycon/calibration.ts',
  'src/input/joycon/rumble.ts',
  'src/input/joycon/stream.ts',
  'src/input/diagnostics.ts',
  'src/input/replay/**',
  'src/config/haptics.ts',
  'src/input/phone/protocol.ts',
];

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'fixtures/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: PURE_LAYERS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'three',
                'three/*',
                'lil-gui',
                '@/render/*',
                '@/ui/*',
                '@/audio/*',
                '@/app/*',
                '@/haptics/*',
                '@/debug/*',
                '@/input/HidManager',
                '@/input/joycon/JoyConDriver',
              ],
              message:
                '仿真/核心层必须保持纯 TS（不依赖 DOM 与 three.js），以便以后移植到电视 App。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'localStorage',
        'performance',
        'requestAnimationFrame',
      ],
    },
  },
]);
