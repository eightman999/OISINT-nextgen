const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const configuredMode = process.env.EXPO_PUBLIC_DATA_PROVIDER_MODE;
const defaultMode = process.env.NODE_ENV === 'production' ? 'live' : 'mock';
const requestedMode = configuredMode || defaultMode;
const mockAllowed =
  process.env.NODE_ENV !== 'production' ||
  (process.env.EXPO_PUBLIC_BUILD_TARGET === 'ci' &&
    process.env.EXPO_PUBLIC_ALLOW_MOCK === 'true');
const providerFile = requestedMode === 'mock' && mockAllowed ? 'mock.ts' : 'live.ts';
const selectedProviderPath = path.join(projectRoot, 'src', 'lib', 'providers', providerFile);
const defaultResolveRequest = config.resolver.resolveRequest;

// Select exactly one provider at bundle resolution time. In a live production export, mock.ts
// and src/data/mock.ts are not reachable from the dependency graph at all.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === './providers/selected') {
    return {
      type: 'sourceFile',
      filePath: selectedProviderPath,
    };
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
