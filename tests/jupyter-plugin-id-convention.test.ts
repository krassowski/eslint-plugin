/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { RuleTester } from '@typescript-eslint/rule-tester';
import * as path from 'path';
import pluginIdConvention from '../src/rules/plugin-id-convention';

const fixtureFilename = path.join(
  __dirname,
  'fixtures',
  'extension-pkg',
  'src',
  'index.ts'
);

const nonExtensionFilename = path.join(__dirname, 'fixtures', 'lazy-plugin.ts');

const corePackageFilename = path.join(
  __dirname,
  'fixtures',
  'core-pkg',
  'src',
  'index.ts'
);

const nestedCorePackageFilename = path.join(
  __dirname,
  'fixtures',
  'extension-pkg',
  'core-nested',
  'src',
  'index.ts'
);

const disabledExtensionFilename = path.join(
  __dirname,
  'fixtures',
  'disabled-extension-pkg',
  'src',
  'index.ts'
);

const mimePackageFilename = path.join(
  __dirname,
  'fixtures',
  'mime-pkg',
  'src',
  'index.ts'
);

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module'
    }
  }
});

// Resolving a renamed namespace import needs the TypeScript program.
const typeAwareTester = new RuleTester({
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      projectService: {
        allowDefaultProject: ['tests/fixtures/mime-pkg/src/*.ts'],
        defaultProject: 'tsconfig.json'
      },
      tsconfigRootDir: path.resolve(__dirname, '..')
    }
  }
});

ruleTester.run('plugin-id-convention', pluginIdConvention, {
  valid: [
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension:plugin',
          description: 'Example plugin',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const PLUGIN_ID = '@jupyterlab/example-extension:main';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: PLUGIN_ID,
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const PLUGIN_ID = '@jupyterlab/example-extension:main';
        const plugin = {
          id: PLUGIN_ID,
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        export default {
          id: '@jupyterlab/example-extension:default',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const plugins: JupyterFrontEndPlugin<any>[] = [
          {
            id: '@jupyterlab/example-extension:first',
            activate: () => {}
          },
          {
            id: '@jupyterlab/example-extension:second',
            activate: () => {}
          }
        ];
      `
    },
    {
      filename: nonExtensionFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: 'other-extension:plugin',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: corePackageFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension:plugin',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: nestedCorePackageFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/core-nested:plugin',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: disabledExtensionFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension:plugin',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: getPluginId(),
          autoStart: true,
          activate: () => {}
        };
      `
    },
    // MIME renderer entries are registered as plugins under their `id`.
    {
      filename: mimePackageFilename,
      code: `
        const extension: IRenderMime.IExtension = {
          id: '@jupyterlab/example-mime:factory',
          rendererFactory
        };
        export default extension;
      `
    },
    {
      filename: mimePackageFilename,
      code: `
        export default [
          {
            id: '@jupyterlab/example-mime:factory',
            rendererFactory,
            rank: 0
          }
        ];
      `
    },
    {
      filename: nonExtensionFilename,
      code: `
        const extension: IRenderMime.IExtension = {
          id: 'other-extension:factory',
          rendererFactory
        };
      `
    },
    // The package name alone matches `disabledExtensions`, `deferredExtensions`
    // and `lockedExtensions` in full, so it is not reported by default.
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension',
          autoStart: true,
          activate: () => {}
        };
      `
    },
    {
      filename: mimePackageFilename,
      code: `
        const extension: IRenderMime.IExtension = {
          id: '@jupyterlab/example-mime',
          rendererFactory
        };
      `
    },
    // IDs assembled from const strings resolve to the right prefix.
    {
      filename: fixtureFilename,
      code: `
        const NS = '@jupyterlab/example-extension';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: \`\${NS}:plugin\`,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const pluginIds = { main: '@jupyterlab/example-extension:main' };
        const plugin: JupyterFrontEndPlugin<void> = {
          id: pluginIds.main,
          activate: () => {}
        };
      `
    },
    // A reassigned variable and a mutated object are not resolved.
    {
      filename: fixtureFilename,
      code: `
        let NS = '@jupyterlab/other-extension';
        NS = '@jupyterlab/example-extension';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: \`\${NS}:plugin\`,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const pluginIds = { main: '@jupyterlab/other-extension:main' };
        pluginIds.main = '@jupyterlab/example-extension:main';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: pluginIds.main,
          activate: () => {}
        };
      `
    },
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: \`\${getPrefix()}:plugin\`,
          activate: () => {}
        };
      `
    }
  ],

  invalid: [
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/other-extension:plugin',
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '@jupyterlab/other-extension:plugin',
            packageName: '@jupyterlab/example-extension'
          }
        }
      ]
    },
    {
      filename: fixtureFilename,
      code: `
        const plugin = {
          id: 'example-extension:plugin',
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const PLUGIN_ID = '@jupyterlab/other-extension:plugin';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: PLUGIN_ID,
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const PLUGIN_ID = '@jupyterlab/other-extension:plugin';
        const plugin = {
          id: PLUGIN_ID,
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const plugin = {
          id: '',
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '',
            packageName: '@jupyterlab/example-extension'
          }
        }
      ]
    },
    {
      filename: fixtureFilename,
      code: `
        const plugins = [
          {
            id: '@jupyterlab/other-extension:first',
            activate: () => {}
          }
        ] satisfies JupyterFrontEndPlugin<any>[];
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // An ID that starts with the package name but has no `:` is another name.
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension-plugin',
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // Angle-bracket assertions type the object like `as` and `satisfies` do:
    // on the object, on an array of objects, and on a factory's return value.
    {
      filename: fixtureFilename,
      code: `
        const plugin = <JupyterFrontEndPlugin<void>>{
          id: '@jupyterlab/other-extension:plugin',
          activate() {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const plugins = <JupyterFrontEndPlugin<void>[]>[
          {
            id: '@jupyterlab/other-extension:plugin',
            activate() {}
          }
        ];
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        function make(): JupyterFrontEndPlugin<void> {
          return <JupyterFrontEndPlugin<void>>{
            id: '@jupyterlab/other-extension:plugin',
            activate() {}
          };
        }
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // IDs assembled from const strings.
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: \`@jupyterlab/other-extension:plugin\`,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const NS = '@jupyterlab/other-extension';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: \`\${NS}:plugin\`,
          activate: () => {}
        };
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '@jupyterlab/other-extension:plugin',
            packageName: '@jupyterlab/example-extension'
          }
        }
      ]
    },
    {
      filename: fixtureFilename,
      code: `
        const NS = '@jupyterlab/other-extension';
        const plugin: JupyterFrontEndPlugin<void> = {
          id: NS + ':' + 'plugin',
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const BASE = '@jupyterlab/other-extension:plugin';
        const PLUGIN_ID = BASE;
        const plugin: JupyterFrontEndPlugin<void> = {
          id: PLUGIN_ID,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/other-extension:plugin' as const,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: fixtureFilename,
      code: `
        const pluginIds = { main: '@jupyterlab/other-extension:main' } as const;
        const plugin: JupyterFrontEndPlugin<void> = {
          id: pluginIds.main,
          activate: () => {}
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // The package name alone is reported only on request.
    {
      filename: fixtureFilename,
      options: [{ reportIdEqualToPackageName: true }],
      code: `
        const plugin: JupyterFrontEndPlugin<void> = {
          id: '@jupyterlab/example-extension',
          autoStart: true,
          activate: () => {}
        };
      `,
      errors: [
        {
          messageId: 'idEqualsPackageName',
          data: {
            pluginId: '@jupyterlab/example-extension',
            packageName: '@jupyterlab/example-extension'
          }
        }
      ]
    },
    {
      filename: fixtureFilename,
      code: `
        function make(): JupyterFrontEndPlugin<void> {
          return {
            id: '@jupyterlab/other-extension:factory',
            activate: () => {}
          };
        }
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // A MIME renderer entry in a package which only declares `mimeExtension`.
    {
      filename: mimePackageFilename,
      code: `
        const extension: IRenderMime.IExtension = {
          id: '@jupyterlab/other-mime:factory',
          rendererFactory
        };
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '@jupyterlab/other-mime:factory',
            packageName: '@jupyterlab/example-mime'
          }
        }
      ]
    },
    // The union JupyterLab's own MIME packages use for the default export.
    {
      filename: fixtureFilename,
      code: `
        const extensions: IRenderMime.IExtension | IRenderMime.IExtension[] = [
          {
            id: '@jupyterlab/example-extension:factory',
            rendererFactory
          },
          {
            id: '@jupyterlab/example-lines-extension:factory',
            rendererFactory
          }
        ];
        export default extensions;
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '@jupyterlab/example-lines-extension:factory',
            packageName: '@jupyterlab/example-extension'
          }
        }
      ]
    },
    // Without a type annotation the entry is recognised by `rendererFactory`.
    {
      filename: mimePackageFilename,
      code: `
        export default [
          {
            id: '@jupyterlab/other-mime:factory',
            rendererFactory,
            rank: 0
          }
        ];
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: mimePackageFilename,
      code: `
        const EXTENSION_ID = '@jupyterlab/other-mime:factory';
        const extension: IRenderMime.IExtension = {
          id: EXTENSION_ID,
          rendererFactory
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // The properties come from a spread, so only the annotation identifies
    // the object as a MIME entry.
    {
      filename: mimePackageFilename,
      code: `
        const extension: IRenderMime.IExtension = {
          id: '@jupyterlab/other-mime:factory',
          ...shared
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: mimePackageFilename,
      code: `
        function make(): IRenderMime.IExtension {
          return {
            id: '@jupyterlab/other-mime:factory',
            ...shared
          };
        }
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: mimePackageFilename,
      code: `
        import * as Interfaces from '@jupyterlab/rendermime-interfaces';
        const extension: Interfaces.IRenderMime.IExtension = {
          id: '@jupyterlab/other-mime:factory',
          ...shared
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    }
  ]
});

typeAwareTester.run('plugin-id-convention (type-aware)', pluginIdConvention, {
  valid: [],
  invalid: [
    // A const imported from another module has a string literal type.
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        import { OTHER_ID } from './ids';
        const extension: IRenderMime.IExtension = {
          id: OTHER_ID,
          rendererFactory
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        import { PluginIDs } from './ids';
        const extension: IRenderMime.IExtension = {
          id: PluginIDs.factory,
          rendererFactory
        };
      `,
      errors: [
        {
          messageId: 'mismatchedPrefix',
          data: {
            pluginId: '@jupyterlab/other-mime:factory',
            packageName: '@jupyterlab/example-mime'
          }
        }
      ]
    },
    // A namespace member, an enum member and a readonly static have string
    // literal types.
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        namespace PluginIDs {
          export const factory = '@jupyterlab/other-mime:factory';
        }
        const extension: IRenderMime.IExtension = {
          id: PluginIDs.factory,
          rendererFactory
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        enum PluginIDs {
          factory = '@jupyterlab/other-mime:factory'
        }
        const extension: IRenderMime.IExtension = {
          id: PluginIDs.factory,
          rendererFactory
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        class Renderer {
          static readonly id = '@jupyterlab/other-mime:factory';
        }
        const extension: IRenderMime.IExtension = {
          id: Renderer.id,
          rendererFactory
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    },
    // The MIME entry type is reached through a renamed namespace import, so
    // only the checker can tell that this object is a MIME renderer entry.
    {
      filename: 'tests/fixtures/mime-pkg/src/type-aware-fixture.ts',
      code: `
        import { IRenderMime as RM } from '../../types';
        const shared = { rendererFactory: {} };
        const extension: RM.IExtension = {
          id: '@jupyterlab/other-mime:factory',
          ...shared
        };
      `,
      errors: [{ messageId: 'mismatchedPrefix' }]
    }
  ]
});
