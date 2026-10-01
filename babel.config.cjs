module.exports = function babelConfig(api) {
  const envName = api.env();
  const productionLive =
    envName === 'production' &&
    process.env.EXPO_PUBLIC_DATA_PROVIDER_MODE !== 'mock';

  return {
    presets: ['babel-preset-expo'],
    plugins: productionLive ? ['./scripts/babel-inline-live-provider-mode.cjs'] : [],
  };
};
