import { Command } from 'commander';
import deepmerge from 'deepmerge';
import { promises as fs } from 'fs';
import path from 'path';
import prompts from 'prompts';
import { z } from 'zod';

import { preFlightInit } from '@/src/preflights/preflight-init';
import { addComponents } from '@/src/utils/add-components';
import { createProject } from '@/src/utils/create-project';
import * as ERRORS from '@/src/utils/errors';
import {
  type Config,
  DEFAULT_COMPONENTS,
  DEFAULT_TAILWIND_CONFIG,
  DEFAULT_TAILWIND_CSS,
  DEFAULT_UTILS,
  getConfig,
  rawConfigSchema,
  resolveConfigPaths,
} from '@/src/utils/get-config';
import { getProjectConfig, getProjectInfo } from '@/src/utils/get-project-info';
import { handleError } from '@/src/utils/handle-error';
import { highlighter } from '@/src/utils/highlighter';
import { logger } from '@/src/utils/logger';
import {
  REGISTRY_URL,
  getDefaultConfig,
  getRegistryBaseColors,
  getRegistryStyles,
} from '@/src/utils/registry';
import { spinner } from '@/src/utils/spinner';
import { updateTailwindContent } from '@/src/utils/updaters/update-tailwind-content';

import { getDifferences } from '../utils/is-different';

export const initOptionsSchema = z.object({
  components: z.array(z.string()).optional(),
  cwd: z.string(),
  defaults: z.boolean(),
  force: z.boolean(),
  isNewProject: z.boolean(),
  name: z.string().optional(),
  pm: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
  silent: z.boolean(),
  srcDir: z.boolean().optional(),
  url: z.string().optional(),
  yes: z.boolean(),
});

export const init = new Command()
  .name('init')
  .description('initialize your project and install dependencies')
  .argument(
    '[components...]',
    'the components to add or a url to the component.'
  )
  .option('-y, --yes', 'skip confirmation prompt.', true)
  .option('-d, --defaults,', 'use default configuration.', false)
  .option('-f, --force', 'force overwrite of existing configuration.', false)
  .option(
    '-c, --cwd <cwd>',
    'the working directory. defaults to the current directory.',
    process.cwd()
  )
  .option('-s, --silent', 'mute output.', false)
  .option(
    '--src-dir',
    'use the src directory when creating a new project.',
    false
  )
  .option('-u, --url <url>', 'registry URL', REGISTRY_URL)
  .option('-n, --name <name>', 'registry name')
  .option('--pm <pm>', 'package manager to use (npm, pnpm, yarn, bun)')
  .action(async (components, opts) => {
    try {
      const options = initOptionsSchema.parse({
        components,
        cwd: path.resolve(opts.cwd),
        isNewProject: false,
        ...opts,
      });

      await runInit(options);

      logger.log(
        `${highlighter.success(
          'Success!'
        )} Project initialization completed.\nYou may now add components.`
      );
      logger.break();
    } catch (error) {
      logger.break();
      handleError(error);
    }
  });

export async function runInit(
  options: z.infer<typeof initOptionsSchema> & {
    skipPreflight?: boolean;
  }
) {
  let projectInfo;

  if (options.skipPreflight) {
    projectInfo = await getProjectInfo(options.cwd);
  } else {
    const preflight = await preFlightInit(options);

    if (preflight.errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT]) {
      const { projectPath } = await createProject(options);

      if (!projectPath) {
        process.exit(1);
      }

      options.cwd = projectPath;
      options.isNewProject = true;
    }

    projectInfo = preflight.projectInfo;
  }

  const res = await getProjectConfig(options.cwd, projectInfo);
  let projectConfig = res?.[0];
  const isNew = res?.[1];

  let config: Config;

  if (projectConfig) {
    if (isNew) {
      projectConfig = await getDefaultConfig(projectConfig, REGISTRY_URL);
      config = await promptForMinimalConfig(projectConfig, {
        ...options,
        url: REGISTRY_URL,
      });

      if (options.url && options.url !== REGISTRY_URL) {
        config = await promptForNestedRegistryConfig(config, options);
      }
    } else {
      config = await promptForNestedRegistryConfig(projectConfig, options);
    }
  } else {
    config = await promptForConfig(await getConfig(options.cwd), REGISTRY_URL);

    if (options.url && options.url !== REGISTRY_URL) {
      config = await promptForNestedRegistryConfig(config, options);
    }
  }
  if (!options.yes) {
    const { proceed } = await prompts({
      initial: true,
      message: `Write configuration to ${highlighter.info(
        'components.json'
      )}. Proceed?`,
      name: 'proceed',
      type: 'confirm',
    });

    if (!proceed) {
      process.exit(0);
    }
  }
  if (config.url === REGISTRY_URL) {
    delete config.url;
  }

  const componentSpinner = spinner(`Writing components.json.`).start();
  const targetPath = path.resolve(options.cwd, 'components.json');
  await fs.writeFile(targetPath, JSON.stringify(config, null, 2), 'utf8');
  componentSpinner.succeed();

  let registryConfig = config;
  let registryName: string | undefined;
  const id = options.name ?? config.name ?? options.url;

  if (id) {
    const registry = config.registries?.[id];

    if (registry) {
      registryName = id;
      registryConfig = deepmerge(config, registry) as any;
    }
  }

  const fullConfig = await resolveConfigPaths(options.cwd, registryConfig);
  const components = ['index', ...(options.components || [])];
  await addComponents(components, fullConfig, {
    isNewProject:
      options.isNewProject || projectInfo?.framework.name === 'next-app',
    overwrite: true,
    registryName,
    silent: options.silent,
  });

  if (options.isNewProject && options.srcDir) {
    await updateTailwindContent(
      ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
      fullConfig,
      {
        silent: options.silent,
      }
    );
  }

  return fullConfig;
}

async function promptForConfig(
  defaultConfig: Config | null = null,
  registryUrl?: string
) {
  const [styles, baseColors] = await Promise.all([
    getRegistryStyles(registryUrl),
    getRegistryBaseColors(),
  ]);

  logger.info('');
  const options = await prompts([
    {
      active: 'yes',
      inactive: 'no',
      initial: defaultConfig?.tsx ?? true,
      message: `Would you like to use ${highlighter.info(
        'TypeScript'
      )} (recommended)?`,
      name: 'typescript',
      type: 'toggle',
    },
    ...(styles.length > 1
      ? [
          {
            choices: styles.map((style) => ({
              title: style.label,
              value: style.name,
            })),
            message: `Which ${highlighter.info(
              'style'
            )} would you like to use?`,
            name: 'style',
            type: 'select',
          },
        ]
      : ([] as any)),
    {
      choices: baseColors.map((color) => ({
        title: color.label,
        value: color.name,
      })),
      message: `Which color would you like to use as the ${highlighter.info(
        'base color'
      )}?`,
      name: 'tailwindBaseColor',
      type: 'select',
    },
    {
      initial: defaultConfig?.tailwind.css ?? DEFAULT_TAILWIND_CSS,
      message: `Where is your ${highlighter.info('global CSS')} file?`,
      name: 'tailwindCss',
      type: 'text',
    },
    {
      active: 'yes',
      inactive: 'no',
      initial: defaultConfig?.tailwind.cssVariables ?? true,
      message: `Would you like to use ${highlighter.info(
        'CSS variables'
      )} for theming?`,
      name: 'tailwindCssVariables',
      type: 'toggle',
    },
    {
      initial: '',
      message: `Are you using a custom ${highlighter.info(
        'tailwind prefix eg. tw-'
      )}? (Leave blank if not)`,
      name: 'tailwindPrefix',
      type: 'text',
    },
    {
      initial: defaultConfig?.tailwind.config ?? DEFAULT_TAILWIND_CONFIG,
      message: `Where is your ${highlighter.info(
        'tailwind.config.js'
      )} located?`,
      name: 'tailwindConfig',
      type: 'text',
    },
    {
      initial: defaultConfig?.aliases.components ?? DEFAULT_COMPONENTS,
      message: `Configure the import alias for ${highlighter.info(
        'components'
      )}:`,
      name: 'components',
      type: 'text',
    },
    {
      initial: defaultConfig?.aliases.utils ?? DEFAULT_UTILS,
      message: `Configure the import alias for ${highlighter.info('utils')}:`,
      name: 'utils',
      type: 'text',
    },
    {
      active: 'yes',
      inactive: 'no',
      initial: defaultConfig?.rsc ?? true,
      message: `Are you using ${highlighter.info('React Server Components')}?`,
      name: 'rsc',
      type: 'toggle',
    },
  ]);

  return rawConfigSchema.parse({
    $schema: 'https://ui.shadcn.com/schema.json',
    aliases: {
      components: options.components,
      hooks: options.components.replace(/\/components$/, 'hooks'),
      // TODO: fix this.
      lib: options.components.replace(/\/components$/, 'lib'),
      utils: options.utils,
    },
    rsc: options.rsc,
    style: options.style,
    tailwind: {
      baseColor: options.tailwindBaseColor,
      config: options.tailwindConfig,
      css: options.tailwindCss,
      cssVariables: options.tailwindCssVariables,
      prefix: options.tailwindPrefix,
    },
    tsx: options.typescript,
    url: options.url,
  }) as Config;
}

async function promptForMinimalConfig(
  defaultConfig: Config,
  opts: z.infer<typeof initOptionsSchema>
) {
  let style = defaultConfig.style;
  let baseColor = defaultConfig.tailwind.baseColor;
  let cssVariables = defaultConfig.tailwind.cssVariables;

  if (!opts.defaults) {
    const [styles, baseColors] = await Promise.all([
      getRegistryStyles(opts.url),
      getRegistryBaseColors(),
    ]);

    const options = await prompts([
      ...(styles.length > 1
        ? [
            {
              choices: styles.map((style) => ({
                title: style.label,
                value: style.name,
              })),
              initial: styles.findIndex((s) => s.name === style),
              message: `Which ${highlighter.info(
                'style'
              )} would you like to use?`,
              name: 'style',
              type: 'select',
            },
          ]
        : ([] as any)),
      {
        choices: baseColors.map((color) => ({
          title: color.label,
          value: color.name,
        })),
        message: `Which color would you like to use as the ${highlighter.info(
          'base color'
        )}?`,
        name: 'tailwindBaseColor',
        type: 'select',
      },
      {
        active: 'yes',
        inactive: 'no',
        initial: defaultConfig?.tailwind.cssVariables,
        message: `Would you like to use ${highlighter.info(
          'CSS variables'
        )} for theming?`,
        name: 'tailwindCssVariables',
        type: 'toggle',
      },
    ]);

    style = options.style ?? style;
    baseColor = options.tailwindBaseColor ?? baseColor;
    cssVariables = options.tailwindCssVariables ?? cssVariables;
  }

  return rawConfigSchema.parse({
    $schema: defaultConfig?.$schema,
    aliases: defaultConfig?.aliases,
    registries: defaultConfig?.registries,
    rsc: defaultConfig?.rsc,
    style,
    tailwind: {
      ...defaultConfig?.tailwind,
      baseColor,
      cssVariables,
    },
    tsx: defaultConfig?.tsx,
    url: opts.url,
  }) as Config;
}

async function promptForNestedRegistryConfig(
  defaultConfig: Config,
  opts: z.infer<typeof initOptionsSchema>
) {
  const nestedDefaultConfig = await getDefaultConfig(
    { ...defaultConfig },
    opts.url
  );

  const name = opts.name ?? nestedDefaultConfig.name ?? opts.url!;

  logger.info('Initializing ' + name + ' registry...');

  const newConfig = await promptForMinimalConfig(nestedDefaultConfig, opts);

  const relevantFields = ['style', 'tailwind', 'rsc', 'tsx', 'aliases'];

  const defaultConfigSubset = Object.fromEntries(
    relevantFields.map((field) => [field, defaultConfig[field as keyof Config]])
  ) as any;

  const newConfigSubset = Object.fromEntries(
    relevantFields.map((field) => [field, newConfig[field as keyof Config]])
  );

  const registryConfig: Config = getDifferences(
    newConfigSubset,
    defaultConfigSubset
  );

  registryConfig.url = opts.url;

  const { resolvedPaths, ...topLevelConfig } = defaultConfig;

  return {
    ...topLevelConfig,
    registries: {
      ...defaultConfig.registries,
      [name]: registryConfig,
    },
  } as Config;
}
